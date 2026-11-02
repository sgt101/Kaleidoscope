FROM node:20-bookworm

# Install LaTeX dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    texlive-latex-base \
    texlive-fonts-recommended \
    texlive-latex-extra \
    texlive-luatex \
    texlive-xetex \
    texlive-bibtex-extra \
    biber \
    cm-super \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# Only the app itself (see .dockerignore): no documents, archives or secrets.
COPY server.js trifle.js providers.js assistant.js ./
COPY public ./public

ENV HOST=0.0.0.0
USER node
EXPOSE 3000

CMD ["node", "server.js"]
