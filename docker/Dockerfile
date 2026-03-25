# ─────────────────────────────────────────────────────────────
#  Trial and Error — Lex & C Sandbox Image
#  Alpine 3.18 · flex · gcc · musl-dev · zip · coreutils (stdbuf)
# ─────────────────────────────────────────────────────────────
FROM alpine:3.18

# flex-dev provides libfl.a (needed for -lfl link flag)
# coreutils provides stdbuf (forces line-buffered output in pipe mode)
RUN apk add --no-cache \
      flex \
      flex-dev \
      gcc \
      musl-dev \
      libc-dev \
      coreutils \
      util-linux \
      zip

WORKDIR /sandbox

# Drop privileges — user code never runs as root
RUN adduser -D -s /bin/sh sandboxuser \
 && chown -R sandboxuser:sandboxuser /sandbox

USER sandboxuser

CMD ["sh"]
