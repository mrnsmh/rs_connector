# --- Étape 1 : build du back-office (frontend Vite) ---
FROM node:20-alpine AS frontend
WORKDIR /fe
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# --- Étape 2 : image backend (sert aussi le frontend construit) ---
FROM node:20-alpine AS base
WORKDIR /app

# Copier package.json ET package-lock.json pour un build reproductible via `npm ci`.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src
COPY scripts ./scripts
# Le frontend construit est servi en statique par le backend (même origine).
COPY --from=frontend /fe/dist ./public

ENV NODE_ENV=production
EXPOSE 3007

CMD ["node", "src/index.js"]
