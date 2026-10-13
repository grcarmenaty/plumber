FROM python:3.12-slim

# git and ssh fetch registered projects, tzdata lets TZ set the time schedules fire in, and nano
# edits the files in the volume
RUN apt-get update \
    && apt-get install -y --no-install-recommends git openssh-client tzdata nano \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/plumber
COPY pyproject.toml README.md LICENSE ./
COPY src ./src
RUN pip install --no-cache-dir .

WORKDIR /plumber
VOLUME /plumber
ENV PLUMBERGUI_HOST=0.0.0.0
EXPOSE 510

# Run Plumber and plumber-gui in /plumber. Plumber keeps 127.0.0.1:509, so only plumber-gui's port
# is reachable from outside the container. plumber-gui starts once Plumber listens, so it doesn't
# log Plumber as down at every boot. When either one stops, the other is stopped too and the
# container exits. An "install" argument writes the sample config.toml instead ("plumber" is $0).
ENTRYPOINT ["bash", "-c", "\
    if [ \"$1\" = install ]; then exec plumber install; fi; \
    trap 'kill -TERM $(jobs -p) 2>/dev/null' TERM INT; \
    plumber & \
    until (: </dev/tcp/127.0.0.1/509) 2>/dev/null; do \
        kill -0 $! 2>/dev/null || { wait $!; exit; }; \
        sleep 0.2; \
    done; \
    plumber-gui & \
    wait -n; \
    status=$?; \
    kill -TERM $(jobs -p) 2>/dev/null; \
    wait; \
    exit $status", "plumber"]
