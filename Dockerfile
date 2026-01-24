FROM node:22-alpine AS runtime

WORKDIR /app

# Copy the build output from the pipeline
COPY .output/ .output/

ENV NODE_ENV=production

# Expose port 80 externally
EXPOSE 80

# Run the server entrypoint with source maps enabled if present
CMD ["node", "--enable-source-maps", ".output/server.mjs"]
