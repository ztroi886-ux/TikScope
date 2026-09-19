# Aryos Group — website + Telegram bot.
#
# PostgreSQL support uses psycopg; requirements are installed before source is
# copied so Docker can cache this layer between code-only deployments.
#
# Railway builds this automatically because a Dockerfile is present at the
# repository root.

FROM python:3.11-slim

# Unbuffered output so the startup banner and log lines reach Railway
# immediately instead of sitting in a buffer.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Railway injects PORT at runtime and app.py reads it. This is only a
# fallback for `docker run` with nothing set.
ENV PORT=8080
EXPOSE 8080

CMD ["python", "app.py"]
