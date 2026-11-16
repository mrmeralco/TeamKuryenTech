# SmartWatts API (FastAPI) for Google Cloud Run, behind the Cloudflare Worker (cloudflare/worker.js).
# The website itself is NOT in this image: Cloudflare serves it. See docs/CLOUDFLARE_DEPLOYMENT.md.
#
#   gcloud run deploy smartwatts-api --source . --region asia-southeast1 ...   (Cloud Build builds this file)
#
# No credentials are baked in: Firestore / Firebase Admin use the Cloud Run service account (metadata server),
# secrets arrive as environment variables from Secret Manager. .gcloudignore / .dockerignore keep the upload to
# backend/, mailer/ and knowledge/ (no .env, keys, node_modules or build output).

# ---- Node runtime + nodemailer for the email mailer (mailer/send.mjs is started as a subprocess) ----------------
FROM node:22-bookworm-slim AS mailer
WORKDIR /deps
RUN npm install --omit=dev --no-audit --no-fund --no-package-lock nodemailer@10.5.0

# ---- API -------------------------------------------------------------------------------------------------------
FROM python:3.13-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HOST=0.0.0.0 \
    PORT=8080 \
    SMARTWATTS_ENV=production

COPY --from=mailer /usr/local/bin/node /usr/local/bin/node
WORKDIR /srv
COPY backend/requirements.txt backend/requirements.txt
# Binary wheels only: no compiler in the image, and grpcio / cryptography come prebuilt for manylinux.
RUN pip install --only-binary=:all: -r backend/requirements.txt
COPY --from=mailer /deps/node_modules node_modules
COPY mailer mailer
COPY knowledge knowledge
COPY backend/serve.py backend/serve.py
COPY backend/app backend/app

# serve.py refuses to run as root.
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin smartwatts
USER 10001
WORKDIR /srv/backend
EXPOSE 8080
CMD ["python", "serve.py"]
