# Portable image for the Autopilot DS backend (which also serves the frontend).
# One worker + threads is REQUIRED: the experiment state and the agent-session
# driver thread live in process memory, and the UI polls must hit the same process.
FROM python:3.12-slim

WORKDIR /app
COPY . /app

RUN pip install --no-cache-dir -r backend/requirements.txt

# Anthropic's Managed Agents sandbox does the heavy compute, so this image stays tiny.
ENV PORT=8000
WORKDIR /app/backend
# Shell form so ${PORT} expands (Render/Railway/Fly/Cloudflare inject PORT).
CMD gunicorn -w 1 --threads 8 --max-requests 0 --timeout 0 -b 0.0.0.0:${PORT:-8000} app:app
