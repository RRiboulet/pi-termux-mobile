FROM mcr.microsoft.com/devcontainers/base:bookworm

# gh's token lives in the pi-config volume (see docker-compose.yml), not in this
# image and not in the container-local home — /home/vscode is discarded on
# rebuild, /home/vscode/.pi is a named volume. Set here rather than mid-file so
# every later layer and postCreate sees it.
ENV GH_CONFIG_DIR=/home/vscode/.pi/gh
ENV GH_PROMPT_DISABLED=1

# Node is needed by two things: `scripts/package-rootfs.ts` runs TypeScript
# directly, and the runtime's own tests run the `.mjs` files. Node strips types
# natively from 22.18, and the runtime asks for >= 22.19, so the LTS line is
# enough and there is no build step anywhere.
RUN curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - \
    && apt-get install -y nodejs

# tmux is not optional: the shared agent setup's subagent extension creates one
# tmux session per delegated run and reports pane state back to the parent.
#
# The JDK and unzip are here for the Android build: openjdk-17 is what AGP
# 8.7.3 needs (the app's own sources are at Java 11 source level, so 17 is the
# floor, and JDK 25 is not supported by that AGP), and unzip unpacks the
# Android SDK's cmdline-tools. The SDK itself is not in the image -- it is
# ~1.5 GB -- `.devcontainer/android-sdk.sh` installs it onto the persistent
# volume instead. `javac -version`, not `java -version`: the JDK is there to
# compile, and a JRE-only image would pass a `java` check.
#
# python3 is for `scripts/prepare-runtime.py`, which packages the runtime
# archive the Gradle build ships. dpkg, dpkg-deb, GNU tar and gzip come with
# the base image and are what `scripts/package-rootfs.ts` needs to unpack the
# Termux packages.
RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
    && apt-get install -y tmux git curl jq unzip python3 openjdk-17-jdk-headless \
    && rm -rf /var/lib/apt/lists/* \
    && javac -version \
    && dpkg-deb --version | head -1 \
    && tar --version | head -1

# gh (GitHub CLI) is how branches reach the remote: `gh pr create` / `gh pr merge`
# drive the PR workflow, and `gh auth setup-git` makes plain `git push` work
# afterwards by installing gh as git's credential helper. Installed from GitHub's
# apt repo so it survives this layer rather than being apted in by hand at runtime,
# which a rebuild would silently drop.
#
# The token itself is NOT baked in. `GH_CONFIG_DIR` points at the pi-config volume
# (see docker-compose.yml), so `gh auth login` survives a rebuild: /home/vscode is
# container-local and is discarded, while /home/vscode/.pi is a named volume.
# `curl | dd` would mask curl's exit status and leave a 0-byte keyring, which apt
# reports as NO_PUBKEY rather than "could not fetch the key". -o plus `test -s`
# keeps the diagnostic honest.
RUN curl -fsSL -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
      https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    && test -s /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && export DEBIAN_FRONTEND=noninteractive \
    && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/* \
    && gh --version \
    && test "${GH_CONFIG_DIR#/home/vscode/.pi}" = "/gh"

# The pi coding agent, so the app can be worked on with the same tools as the
# shared setup. The *extensions* are not here: this repository declares the
# shared setup as a pi package in .pi/settings.json, and pi clones it into
# .pi/git/ on first use.
RUN npm cache clean --force \
    && npm install -g --no-audit --no-fund @earendil-works/pi-coding-agent@latest \
    && pi --version

# ANDROID_HOME and PATH are image content, not something a postCreate step
# writes at container creation. Writing shell rc files from a postCreate step is
# what an earlier version of the sibling container did, and it replaced the
# whole file with a temp-file path on every rebuild. Baked lines cannot be lost
# that way, and they reach VS Code's non-login terminals, tmux panes and login
# shells alike. The SDK path is fixed and lives on the volume, so the exports
# are correct before the SDK is installed.
RUN cat <<'EOF' >> /home/vscode/.zshrc
export ANDROID_HOME=/home/vscode/.pi/android-sdk
export ANDROID_SDK_ROOT=/home/vscode/.pi/android-sdk
export PATH=$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH
EOF

RUN cat <<'EOF' >> /home/vscode/.bashrc
export ANDROID_HOME=/home/vscode/.pi/android-sdk
export ANDROID_SDK_ROOT=/home/vscode/.pi/android-sdk
export PATH=$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH
EOF

# gh's credential helper, system-wide, so `git push` works in a FRESH container.
# `gh auth setup-git` writes to ~/.gitconfig, which is on the container-local
# overlay and is discarded on rebuild — the token survives (it lives on the
# volume) but the thing that lets git USE it does not, so push breaks after
# every rebuild.
RUN git config --system credential.https://github.com.helper '' \
    && git config --system credential.https://github.com.helper '!/usr/bin/gh auth git-credential' \
    && git config --system credential.https://gist.github.com.helper '' \
    && git config --system credential.https://gist.github.com.helper '!/usr/bin/gh auth git-credential' \
    && git config --system alias.st status \
    && git config --system alias.co checkout \
    && git config --system alias.br branch \
    && git config --system alias.last 'log -1 HEAD --stat' \
    && git config --system alias.lg 'log --oneline --decorate --graph -20'

WORKDIR /workspace
