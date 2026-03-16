FROM node:20
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
# Build compiles TypeScript; postbuild hook downloads models/silero_vad.onnx
RUN npm run build
EXPOSE 3000
CMD ["node", "dist/src/server.js"]
