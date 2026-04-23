FROM denoland/deno:2.1.4

WORKDIR /app

COPY deno.json deno.lock* ./
COPY *.ts ./
COPY *.sql ./

RUN deno cache main.ts

# /data is provided by a Railway volume mounted at runtime — see
# https://docs.railway.com/volumes/reference (VOLUME keyword is banned).
CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--allow-ffi", "main.ts"]
