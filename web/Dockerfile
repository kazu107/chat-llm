FROM node:24-alpine AS deps
WORKDIR /app

# package-lock.json があれば一緒にコピーされる
COPY package*.json ./

# lockfile有り: npm ci / 無し: npm install
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

FROM node:24-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules /app/node_modules
COPY . .
RUN npm run build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY --from=builder /app ./
EXPOSE 3000
CMD ["npm","run","start","--","-H","0.0.0.0","-p","3000"]
