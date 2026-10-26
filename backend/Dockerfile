FROM node:22-slim

# Install OpenSSL and CA certificates required by Prisma and HTTPS requests
RUN apt-get update -y && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy Prisma schema and generate client
COPY prisma ./prisma/
COPY prisma7.config.ts ./
RUN npx prisma generate

# Copy source code
COPY . .

CMD ["npm", "run", "worker"]
