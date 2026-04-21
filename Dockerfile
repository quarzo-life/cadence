FROM denoland/deno:2.1.4

WORKDIR /app

COPY deno.json deno.lock* ./
COPY *.ts ./
COPY *.sql ./

RUN deno cache main.ts

VOLUME /data

CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--allow-ffi", "main.ts"]
