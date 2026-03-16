FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
# Build compiles TypeScript; postbuild hook downloads models/silero_vad.onnx
RUN npm run build
EXPOSE 3000
CMD ["node", "dist/server.js"]
