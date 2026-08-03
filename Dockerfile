ARG NODE_IMAGE=node:22.21.1

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build:server

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV CHAT2API_HOST=0.0.0.0
ENV CHAT2API_PORT=8080
ENV CHAT2API_DATA_DIR=/data
ENV CHAT2API_COMPACTION_DETECTION=auto
ENV CHAT2API_QWEN_AI_COMPACTION_THINKING=auto
# Compaction input uses live model limits first; these values are deployment
# controls for an explicit override, optional metadata cap, or a
# catalogue-without-limits fallback. Zero leaves live metadata uncapped.
ENV CHAT2API_QWEN_AI_COMPACTION_INPUT_TOKEN_BUDGET=0
ENV CHAT2API_QWEN_AI_COMPACTION_METADATA_MAX_INPUT_TOKENS=0
ENV CHAT2API_QWEN_AI_COMPACTION_FALLBACK_INPUT_TOKENS=12000
ENV CHAT2API_QWEN_AI_COMPACTION_PROMPT_TOKEN_RESERVE=512
ENV CHAT2API_QWEN_AI_COMPACTION_CHUNK_DELAY_MS=0
ENV CHAT2API_QWEN_AI_COMPACTION_MAX_REDUCTION_ROUNDS=6
# Zero means use the complete active account pool discovered at runtime.
ENV CHAT2API_QWEN_AI_COMPACTION_MAX_ACCOUNT_ATTEMPTS=0
# Limit simultaneous recovery candidates only; account rotation still uses
# the complete active pool unless the deployment sets an attempt cap.
ENV CHAT2API_QWEN_AI_COMPACTION_FAILOVER_WAVE_SIZE=2
ENV CHAT2API_QWEN_AI_MAX_ACCOUNT_FAILOVERS=0
# Keep the adaptive pacing floor aligned with the validated multi-account
# deployment; upstream 429/risk responses still control account cooldowns.
ENV CHAT2API_QWEN_AI_AUTO_TUNE_MIN_GLOBAL_INTERVAL_MS=1000
# Docker deployments allow long active generations while still bounding
# streams that stop producing data. Queue admission remains independent.
ENV CHAT2API_QWEN_AI_QUEUE_TIMEOUT_MS=120000
# Keep one effective governor slot available for ordinary client requests
# while a context-compaction map/reduce is active.
ENV CHAT2API_QWEN_AI_COMPACTION_RESERVED_SLOTS=1
# Managed-tool validation buffering is opt-in; the default preserves live SSE.
ENV CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS=false
# A transport reset can continue the same Qwen response without resubmitting
# the prompt. Deployments can tune or disable this bounded recovery budget.
ENV CHAT2API_QWEN_AI_STREAM_RESUME_ATTEMPTS=3
ENV CHAT2API_QWEN_AI_STREAM_RESUME_DELAY_MS=1000
# Response-id resumes and managed workflow continuations share this
# no-progress budget; it pauses while a replacement stream is active.
ENV CHAT2API_QWEN_AI_RECOVERY_BUDGET_MS=180000
# Busy-chat admission is bounded separately from the long generation timeout.
ENV CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_BUDGET_MS=300000
ENV CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_DELAY_MS=1000
ENV CHAT2API_VALIDATED_SSE_MAX_HOLD_MS=60000
ENV CHAT2API_SSE_KEEPALIVE_INTERVAL_MS=15000
ENV QWEN_AI_REQUEST_TIMEOUT_MS=600000
# Active streams are bounded by meaningful inactivity, not total wall time.
# Set a positive value at deployment time only when an absolute cap is needed.
ENV QWEN_AI_RESPONSE_TIMEOUT_MS=0
ENV QWEN_AI_STREAM_IDLE_TIMEOUT_MS=180000
ENV QWEN_AI_OSS_STS_REFRESH_INTERVAL_MS=240000
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/out-server ./out-server
COPY --from=build /app/out-admin ./out-admin
COPY --from=build /app/sha3_wasm_bg.7b9ca65ddd.wasm ./sha3_wasm_bg.7b9ca65ddd.wasm
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "out-server/server/index.js"]
