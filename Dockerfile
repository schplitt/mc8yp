FROM node:22-slim AS runtime

WORKDIR /app

# Copy the build output from the pipeline
COPY dist/ dist/

ENV NODE_ENV=production
ENV PORT=80
ENV HOST=0.0.0.0

# Create a non-root user for running the server (do not chown files)
RUN addgroup --system --gid 1001 app && \
    adduser --system --uid 1001 --ingroup app app || true

USER app

# Expose port 80 externally
EXPOSE 80

# Run the server entrypoint with source maps enabled if present
CMD ["node", "--enable-source-maps", "dist/index.mjs"]
