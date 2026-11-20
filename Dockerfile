FROM node:20-bookworm

# Install LaTeX dependencies, and Git for version history (named so a change of base image cannot drop it)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    texlive-latex-base \
    texlive-fonts-recommended \
    texlive-latex-extra \
    texlive-luatex \
    texlive-xetex \
    texlive-bibtex-extra \
    biber \
    cm-super \
    && rm -rf /var/lib/apt/lists/*

# Open fonts for fontspec documents, in a layer of their own so that adding one does not reinstall TeX Live. Keep
# CONTAINER_NOTE in assistant.js in step. Liberation, Carlito and Caladea match the metrics of Arial, Times New Roman, Courier
# New, Calibri and Cambria; TeX Gyre and URW (Nimbus Sans) match Helvetica and the PostScript 35. No proprietary fonts.
RUN apt-get update && apt-get install -y --no-install-recommends \
    fonts-liberation2 \
    fonts-texgyre \
    fonts-texgyre-math \
    fonts-urw-base35 \
    fonts-crosextra-carlito \
    fonts-crosextra-caladea \
    fonts-noto-core \
    fonts-noto-mono \
    fonts-open-sans \
    fonts-roboto-unhinted \
    fonts-lato \
    fonts-inter \
    fonts-ebgaramond \
    fonts-linuxlibertine \
    fonts-inconsolata \
    fonts-firacode \
    fonts-jetbrains-mono \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# Only the app itself (see .dockerignore): no documents, archives or secrets.
COPY server.js trifle.js providers.js assistant.js history.js synctex.js ./
COPY public ./public

# KALEIDOSCOPE_CONTAINER tells the assistant what it can and cannot rely on here (CONTAINER_NOTE in assistant.js).
ENV HOST=0.0.0.0 KALEIDOSCOPE_CONTAINER=1
USER node
EXPOSE 3000

CMD ["node", "server.js"]
