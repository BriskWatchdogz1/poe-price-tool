#!/bin/sh
# Fixes the one thing that made the documented "needs only Docker" setup unable
# to save anything:
#
# docker-compose mounts ./config into /config. If that host folder does not
# exist yet, DOCKER creates it — owned by root:root, mode 755. The service runs
# as `node` (uid 1000), so every write into /config failed with EACCES: the
# per-tab store, the net-worth history, the rate-limit state, and the POESESSID
# from the settings dialog. Nothing crashed; the features just silently could
# not persist.
#
# So: while we are still root, hand /config to the service user, then drop to it
# for good. `exec` keeps PID 1, so signals and `docker stop` behave normally.
#
# If the operator pins a user themselves (compose `user:`), this runs unprivileged
# and simply execs the command — their choice wins, and chown would fail anyway.
set -e

# Can the service user actually create a file in /config? A real write, not a
# permission-bit guess: group membership, ACLs and read-only mounts all show up.
can_write () {
  _p=/config/.write-probe.$$
  if setpriv --reuid=node --regid=node --init-groups sh -c "touch '$_p' 2>/dev/null"; then
    rm -f "$_p" 2>/dev/null || true
    return 0
  fi
  return 1
}

if [ "$(id -u)" = "0" ]; then
  if ! can_write; then
    owner=$(stat -c '%u' /config 2>/dev/null || echo 0)
    if [ "$owner" = "0" ]; then
      # Owned by root: this is the folder docker created because the bind-mount
      # target did not exist. Nobody else has a claim on it, so take it.
      chown -R node:node /config 2>/dev/null || \
        echo "[entrypoint] WARNING: /config is root-owned and could not be chowned — nothing will persist" >&2
    else
      # Owned by someone else — a NAS share (Unraid uses nobody:users) or a
      # deliberate choice. Taking it over can break SMB access to the same
      # folder, so try joining its group instead, and if that fails say so
      # rather than rewriting ownership behind the operator's back.
      gid=$(stat -c '%g' /config 2>/dev/null || echo '')
      if [ -n "$gid" ] && usermod -aG "$gid" node 2>/dev/null && can_write; then
        echo "[entrypoint] joined group $gid to write /config (owner $owner left untouched)" >&2
      else
        echo "[entrypoint] WARNING: /config is owned by uid $owner and not writable by the service user." >&2
        echo "[entrypoint]          Ownership left alone on purpose. Fix with: chown -R 1000:1000 <config dir>" >&2
      fi
    fi
  fi
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

exec "$@"
