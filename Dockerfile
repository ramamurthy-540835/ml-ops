FROM node:20-bookworm-slim AS web-build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY app ./app
COPY components ./components
COPY lib ./lib
COPY next.config.mjs tsconfig.json next-env.d.ts ./
RUN npm run build

FROM python:3.11-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PORT=8080
COPY requirements.txt requirements.ml.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
COPY --from=web-build /app/out ./out
CMD exec uvicorn main:app --host 0.0.0.0 --port ${PORT}
