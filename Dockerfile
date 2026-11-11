# Image cho API + realtime (apps/server). Dùng để deploy lên Render.
# Server chạy TypeScript trực tiếp bằng tsx (giống lúc dev), vì packages/shared xuất mã nguồn .ts.
FROM node:22-alpine

WORKDIR /app

# Cài thư viện trước để Docker cache lại lớp này khi chỉ sửa code.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
# Cài đủ cả devDependencies: cần tsx để chạy, và packages/shared dùng fractional-indexing lúc chạy.
RUN npm ci --include=dev && npm cache clean --force

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/server apps/server

ENV NODE_ENV=production
# Render tự đặt PORT; server đọc API_PORT rồi tới PORT.
EXPOSE 10000

# Chạy migration (chỉ áp dụng file mới) rồi mới mở server.
WORKDIR /app/apps/server
CMD ["sh", "-c", "npx tsx src/scripts/migrate.ts && exec npx tsx src/index.ts"]
