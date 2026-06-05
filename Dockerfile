FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
# Each compose service overrides this with its own `command`.
CMD ["node", "--version"]
