FROM denoland/deno:latest

WORKDIR /app

RUN deno --version

COPY deno.json deno.lock* ./
RUN echo "=== deno.lock ===" && cat deno.lock || true

COPY *.ts ./
COPY *.sql ./

RUN pwd && ls -la
RUN deno cache main.ts

# /data is provided by a Railway volume mounted at runtime — see
# https://docs.railway.com/volumes/reference (VOLUME keyword is banned).
CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--allow-ffi", "main.ts"]
