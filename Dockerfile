# Specify the base Docker image
FROM apify/actor-node:22 AS builder

# Copy just package.json and package-lock.json
COPY --chown=myuser:myuser package*.json ./

# Install all dependencies
RUN npm install --include=dev --audit=false

# Copy source files
COPY --chown=myuser:myuser . ./

# Build the project
RUN npm run build

# Create final image
FROM apify/actor-node:22

# Copy just package.json and package-lock.json
COPY --chown=myuser:myuser package*.json ./

# Install production dependencies only
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version \
    && rm -r ~/.npm

# Copy built JS files from builder image
COPY --from=builder --chown=myuser:myuser /usr/src/app/dist ./dist

# Copy remaining files
COPY --chown=myuser:myuser . ./

# Run the image
CMD npm run start:prod --silent
