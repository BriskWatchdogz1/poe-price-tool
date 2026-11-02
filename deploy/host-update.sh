#!/bin/sh
#
# poe-price-tool — update-on-request, run on the DOCKER HOST by cron.
#
# ---------------------------------------------------------------------------
# WHAT THIS IS FOR
#
# The admin area of the tool has an "update" button. The tool runs in a
# container and cannot rebuild itself: `git pull && docker compose up -d
# --build` needs a checkout and a docker daemon that live out here. So the
# container only ASKS — it writes a file into the /config volume it shares with
# this host — and this script decides what actually happens.
#
# WHY NOT JUST GIVE THE CONTAINER THE DOCKER SOCKET
#
# Because /var/run/docker.sock is unauthenticated root on this machine. Any
# process that can reach it can start a container with / bind-mounted and own
# the host. The tool it would be handed to has no authentication at all (it is
# a LAN tool by design), its admin area sits behind one plaintext password
# whose default is published in its public repository, and it parses text
# fetched from the internet all day long. Mounting the socket there would trade
# the whole host for the convenience of a button.
#
# THE FIRST RULE THAT MAKES THIS SAFE — DO NOT BREAK IT
#
#     NOTHING FROM THE REQUEST FILE IS EVER USED.
#
# This script reads the request file only to learn THAT somebody pressed the
# button. It never reads a value out of it, never puts its content into a
# variable that ends up in a command, never sources it, never expands it. The
# directory and the command below are constants in this file and nowhere else.
#
# That is the entire security argument. Whoever can write into the /config
# volume can trigger this script — that is accepted, and harmless, because the
# most it can ever do is rebuild the code that is already checked out here. The
# moment a branch name, a tag, a path or any other value travels from the file
# into the command, that stops being true: the request becomes an instruction,
# and anyone who reaches the admin area gets arbitrary code execution on this
# host. If you are tempted to "just pass the branch along" — that is the hole.
# Change the constant below instead and commit it.
#
# THE SECOND RULE, WHICH IS THE SAME ONE ABOUT FILES
#
#     NOTHING IN THE SHARED DIRECTORY IS TRUSTED TO BE WHAT IT LOOKS LIKE.
#
# This script runs as root; the container can write into CONFIG_DIR. So a name
# in there may be a symlink, a directory or a FIFO instead of the plain file it
# is supposed to be, and each of those aims a root process somewhere it was not
# meant to go:
#
#   - `cat > file` FOLLOWS a symlink. A predictable staging path inside the
#     shared directory would let anything the container can name be truncated
#     and rewritten by root. That is why every staging file is created by
#     `mktemp` in WORK_DIR, which the container cannot reach.
#   - `cat > fifo` BLOCKS until somebody reads. The same path as a FIFO would
#     hang this script for good, on every run, and the heartbeat would stop.
#   - `mkdir`/`rm` fail on the wrong kind of file, which is why the LOCK also
#     lives in WORK_DIR: in the shared directory the container could occupy it
#     and the updater would never run again.
#   - `rename()` (what `mv` does within one filesystem) does NOT follow
#     symlinks and opens nothing. That is what makes publishing INTO the shared
#     directory safe at all.
#
# Everything else is `plain()` below: a path in the shared directory that
# exists and is not a plain file stops the run with a message. Loudly, and
# without working around it — that is the state where somebody has been in
# there.
#
# ---------------------------------------------------------------------------
# INSTALLING IT
#
# Adjust the constants below, make the file executable (chmod +x) and run it on
# a schedule — every 5 minutes is what the tool's UI expects:
#
#   * Unraid, "User Scripts" plugin: add a script, paste this in, set the
#     schedule to "Custom" with the cron expression  */5 * * * *
#   * plain cron:      */5 * * * * /path/to/host-update.sh >/dev/null 2>&1
#   * systemd timer:   OnUnitActiveSec=5min, calling this script — but read the
#     note at the heartbeat below first: a systemd `Type=oneshot` run does not
#     behave like a cron tick while a build is in progress.
#
# It must run as a user that may use docker and may write in the checkout —
# usually root on a home server. It exits within milliseconds when there is
# nothing to do.
#
# Without this script installed, nothing changes: the tool shows a disabled
# button and says an updater is not set up. See docs/admin.md.
#
# RUN A COPY, NOT THIS FILE. Install it somewhere outside the checkout. This
# script's job is to `git pull` the checkout it ships in, and a pull can replace
# the script file while the shell is still reading it — `sh` reads a script
# incrementally by byte offset, so a file swapped mid-run resumes at the old
# offset in new content. That does not fail cleanly. A copy also keeps the two
# constants below out of the way of the next pull.
# ---------------------------------------------------------------------------

set -eu

# ===========================================================================
# ADJUST THESE TWO — they are the only configuration, and they are constants
# on purpose (see "THE FIRST RULE" above).
# ===========================================================================

# The checkout that holds docker-compose.yml. Example from an Unraid box; use
# whatever path your own deployment lives in.
REPO_DIR="/mnt/user/appdata/poe-price-tool"

# The HOST side of the container's /config volume — the same directory the
# compose file mounts as /config. The shipped compose file mounts `./config`,
# so in a checkout made the way the README describes this is the checkout's own
# `config` subdirectory, as below. That nesting is fine; the reverse is not,
# and section 0 says why.
CONFIG_DIR="/mnt/user/appdata/poe-price-tool/config"

# ===========================================================================
# Nothing below here needs adjusting.
# ===========================================================================

# This script's own directory: the lock and every staging file live HERE and
# never in CONFIG_DIR, because the container can write into that one (second
# rule above). The default is a SIBLING of the config directory, which gets
# both properties this place needs:
#
#   - outside the volume: the compose file mounts CONFIG_DIR itself, not its
#     parent, so nothing in the container can see or touch this;
#   - on the same filesystem as CONFIG_DIR, which is what keeps `publish()`
#     below an atomic rename. Somewhere "tidier" like /var/lib is exactly what
#     this must not be: across a filesystem boundary `mv` copies instead of
#     renaming, and the container polls those files.
#
# In the standard arrangement that puts it INSIDE the checkout, next to
# `config/`. Two consequences, both handled and neither of them optional: the
# repository's .gitignore has `config.host-update/` so it stays out of
# `git status`, and its .dockerignore has it so the staging files — which hold
# the RAW build output, redaction happens later in the server — stay out of the
# build context. Section 0 checks the second one.
#
# Change it only to somewhere with those same properties.
WORK_DIR="${CONFIG_DIR%/}.host-update"

REQUEST="$CONFIG_DIR/update-request"
HEARTBEAT="$CONFIG_DIR/update-heartbeat"
RESULT="$CONFIG_DIR/update-result"
LOCK="$WORK_DIR/update.lock"
LOCK_STARTED="$WORK_DIR/update.lock.started"

# How much of the build output is kept in the result file. The tool caps it a
# second time before showing it.
OUTPUT_KEEP_BYTES=4000

# When a held lock stops being "a build is running" and starts being "a run
# died holding it". Two hours is far past any build of this image on any
# machine that could run it at all, so this never fires at a working updater;
# it is a report, not a deadline the build has to meet.
STALE_LOCK_SECONDS=7200

now() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
fail() { echo "poe-price-tool update: $1" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 0. THE CHECKOUT MUST NOT LIE INSIDE THE SHARED DIRECTORY.
#
# This is the one misconfiguration that turns the whole design around. All of
# the above rests on the container being able to write nothing but a request
# file that is never read. If REPO_DIR lies INSIDE CONFIG_DIR — or the two are
# the same — then the container can write the CHECKOUT too: docker-compose.yml,
# the Dockerfile, the source. The next press of the button makes this script
# build and run whatever it put there, as root, out here. That is real remote
# code execution, and no amount of care with the request file prevents it.
#
# THE OTHER DIRECTION IS THE STANDARD ARRANGEMENT AND IS ALLOWED. `git clone`
# and `docker compose up -d --build` leave CONFIG_DIR INSIDE REPO_DIR, because
# the shipped compose file mounts `./config` — a subdirectory of the checkout.
# That nesting hands the container nothing: a bind mount goes one way, the
# container sees the directory that was mounted into it and not the tree it was
# taken from. This script used to refuse it anyway, which made the button
# unusable for every installation that followed the README.
#
# What cannot be checked from here, and what you have to keep true yourself:
# whether the checkout is ALSO bind-mounted into the container under some other
# path. Do not do that — docs/admin.md, "Update button".
# ---------------------------------------------------------------------------
inside() { case "${1%/}/" in "${2%/}"/*) return 0 ;; esac; return 1; }
if [ "${REPO_DIR%/}" = "${CONFIG_DIR%/}" ] || inside "$REPO_DIR" "$CONFIG_DIR"; then
  fail "REPO_DIR ($REPO_DIR) is inside CONFIG_DIR ($CONFIG_DIR), or they are the same directory. The container can write into the config directory, so it could write into the checkout this script builds — that is code execution on this host. Move the checkout out of the shared directory and run again. (The reverse — the config directory inside the checkout — is the normal arrangement and is fine.)"
fi

# ---------------------------------------------------------------------------
# 0b. …BUT WHAT THE CONTAINER WRITES MUST STAY OUT OF THE BUILD CONTEXT.
#
# The nesting above is harmless for code execution and not free of conditions.
# `docker compose up -d --build` sends the WHOLE checkout to the docker daemon
# minus what .dockerignore excludes, and in the standard arrangement CONFIG_DIR
# and WORK_DIR sit in that checkout. CONFIG_DIR holds every user's POESESSID
# and the admin password; WORK_DIR holds the unredacted tail of the last build.
# Today's Dockerfile copies neither, so nothing of it reaches the image — but
# this script is the thing that starts those builds, so it does not start one
# that ships them to the daemon.
#
# The matcher below is the part that can be answered from here. It reads
# .dockerignore the way docker does — patterns in order, last match wins, `!`
# re-includes — and `case` does the globbing, so `config`, `config/`, `/config`,
# `./config`, `**/config`, `config/*` and `conf*` all read as "excluded", as
# they do for docker. A pattern it cannot make sense of simply does not match,
# and that direction is the safe one: it costs a run, never a false all-clear.
# ---------------------------------------------------------------------------
excluded_from_build_context() {  # $1 = path relative to the checkout
  ctx_verdict=no
  while IFS= read -r ctx_pat || [ -n "$ctx_pat" ]; do
    case "$ctx_pat" in '' | '#'*) continue ;; esac
    ctx_hit=yes
    case "$ctx_pat" in '!'*) ctx_hit=no; ctx_pat="${ctx_pat#'!'}" ;; esac
    ctx_pat="${ctx_pat#'./'}"; ctx_pat="${ctx_pat#/}"; ctx_pat="${ctx_pat%/}"; ctx_pat="${ctx_pat#'**/'}"
    # The directory itself, and something in it: `config/*` excludes the
    # contents without matching the name, and the contents are the secret.
    case "$1" in $ctx_pat) ctx_verdict=$ctx_hit ;; esac
    case "$1/x" in $ctx_pat) ctx_verdict=$ctx_hit ;; esac
  done < "$REPO_DIR/.dockerignore"
  [ "$ctx_verdict" = yes ]
}

for dir in "$CONFIG_DIR" "$WORK_DIR"; do
  inside "$dir" "$REPO_DIR" || continue
  rel="${dir%/}"; rel="${rel#"${REPO_DIR%/}"/}"
  [ -f "$REPO_DIR/.dockerignore" ] && excluded_from_build_context "$rel" ||
    fail "$dir is inside the checkout and $REPO_DIR/.dockerignore does not exclude it. Every build this script runs would send it to the docker daemon — the config directory holds POESESSID and the admin password, the work directory holds the raw build output. Add a line '$rel' to $REPO_DIR/.dockerignore and run again. (Only a line this script can recognise counts; if you exclude it with some pattern of your own, add the plain line as well.)"
done

mkdir -p "$CONFIG_DIR"
mkdir -p "$WORK_DIR" 2>/dev/null ||
  fail "cannot create $WORK_DIR. It holds the lock and the staging files and must NOT be inside CONFIG_DIR (the container writes there). Point WORK_DIR at another directory the container cannot reach, on the same filesystem as CONFIG_DIR."
chmod 700 "$WORK_DIR"

# ---------------------------------------------------------------------------
# Refuse to touch anything in the shared directory that is not a plain file.
# ---------------------------------------------------------------------------
plain() {
  if [ -L "$1" ] || { [ -e "$1" ] && [ ! -f "$1" ]; }; then
    fail "$1 is not a plain file — it is a symlink, a directory or a pipe. That directory is shared with the container, so this is not an accident: refusing to touch it. Look at it before you delete it."
  fi
}

# Content from stdin, staged privately, then moved into the shared directory.
#
# The staging file is created by `mktemp` in WORK_DIR: an unpredictable name in
# a directory the container cannot reach. The `mktemp TEMPLATE` form is used
# because it is the one every implementation understands (GNU, BSD and busybox
# all take a template argument; `-p` and the argument-less form do not travel).
#
# ATOMICITY: `mv` is an atomic rename only WITHIN one filesystem. Across a
# filesystem boundary it degrades to copy-and-delete, and the container polls
# these files — it would then be able to read a half-written one. WORK_DIR
# therefore lives next to CONFIG_DIR, on the same filesystem. Keep it that way
# if you move it; the safety of the final names rests on `rename()`, not on the
# staging.
#
# Each call cleans up only ITS OWN staging file, never by pattern: several runs
# are in here at once (every cron tick refreshes the heartbeat while a build
# holds the lock), and a `rm publish.*` would race one of them out from under
# the other. A run killed with SIGKILL therefore leaves a few kilobytes behind
# in this directory — the one thing here no trap can clean up, and the cheaper
# side of that trade.
publish() {
  plain "$1"
  tmp="$(mktemp "$WORK_DIR/publish.XXXXXX")"
  cat > "$tmp" || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$1" || { rm -f "$tmp"; return 1; }
}

# ---------------------------------------------------------------------------
# 1. Is a lock lying around from a run that never finished?
#
# The lock is taken further down; it is only INSPECTED here, because what we
# find has to travel out in the heartbeat that is written next. A hard kill —
# host reboot in the middle of a build, SIGKILL, anything the trap does not see
# — leaves the lock behind, and from then on every run writes its heartbeat and
# exits at the lock. Without this, the tool would go on reporting "updater
# installed and healthy" while no request is ever picked up again, which is
# exactly the failure nobody finds.
#
# It is REPORTED, never broken open. Breaking a lock on age alone is a guess
# that the run holding it is dead; guess wrong and two `docker compose build`s
# run against the same image at once, which is the damage the lock exists to
# prevent. So the tool is told, it disables its button and says what is wrong,
# and a human removes an empty directory.
# ---------------------------------------------------------------------------
STUCK_SINCE=''
if [ -d "$LOCK" ] && [ -f "$LOCK_STARTED" ]; then
  # Two fields, written when the lock was taken: seconds since the epoch (to
  # subtract) and the same moment in the readable form the tool shows.
  lock_epoch=''
  lock_iso=''
  read -r lock_epoch lock_iso < "$LOCK_STARTED" || true
  case "$lock_epoch" in '' | *[!0-9]*) lock_epoch='' ;; esac
  if [ -n "$lock_epoch" ] && [ "$(( $(date +%s) - lock_epoch ))" -gt "$STALE_LOCK_SECONDS" ]; then
    # The readable half only decorates the message; if a crash truncated the
    # file mid-write, the fact still travels and the time says it does not know.
    STUCK_SINCE="${lock_iso:-unknown}"
  fi
fi

# ---------------------------------------------------------------------------
# 2. The heartbeat, on EVERY run, before anything that can take time.
#
# This is how the tool knows an updater exists at all; without a fresh one it
# disables its button. It is written before the lock is taken on purpose: a
# build can run for many minutes, and during that time the SCHEDULE keeps
# starting this script, and those runs exit at the lock — they must keep the
# heartbeat fresh, or the UI would declare the updater dead in the middle of
# the very update it asked for.
#
# HOW FAR THAT REACHES. It holds wherever the schedule starts runs
# INDEPENDENTLY of each other: cron and Unraid's User Scripts do. A systemd
# `Type=oneshot` service driven by a timer does NOT — while the one run is
# inside the build, systemd starts no second one, so nothing refreshes the
# heartbeat until the build is over. With that setup a build longer than the
# tool's window (20 min by default) makes the admin area say "not set up" in
# the middle of the update; raise POE_UPDATE_HEARTBEAT_MAX_AGE_MS past your
# worst build, or use cron. docs/admin.md says the same next to the unit.
# ---------------------------------------------------------------------------
{
  printf 'at=%s\n' "$(now)"
  # Only present when something is wrong; the tool shows "stuck" instead of
  # "healthy" for as long as it is.
  [ -z "$STUCK_SINCE" ] || printf 'stuck-since=%s\n' "$STUCK_SINCE"
} | publish "$HEARTBEAT"

# A stuck lock stops the run HERE, after the heartbeat has carried the fact out
# to the tool and before anything else is touched. Loud on every run and not
# only when somebody presses the button, because an updater that cannot pick
# anything up is broken now, not later.
[ -z "$STUCK_SINCE" ] ||
  fail "the lock $LOCK has been held since $STUCK_SINCE, longer than any build takes — the run that took it is gone. NOTHING WILL UPDATE until it is removed. Check that no build is really running, then: rm -f $LOCK_STARTED && rmdir $LOCK. The admin area is showing this too, and any pending request stays where it is."

# ---------------------------------------------------------------------------
# 3. Is there a request? No request, no update. Ever.
#
# There is deliberately no "check for new commits anyway" and no daily pull:
# an update replaces running code, and that happens when a human asks for it.
# ---------------------------------------------------------------------------
plain "$REQUEST"
[ -f "$REQUEST" ] || exit 0

# ---------------------------------------------------------------------------
# 4. One at a time. Two concurrent builds of the same image are real damage.
#
# mkdir is atomic on every POSIX filesystem, which is why the lock is a
# directory and not a file — and it is in WORK_DIR, where only this host can
# create it. In the shared directory the container could simply create it once
# and no update would ever run again.
# ---------------------------------------------------------------------------
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "poe-price-tool update: another run is still working — leaving the request in place"
  exit 0
fi
printf '%s %s\n' "$(date +%s)" "$(now)" > "$LOCK_STARTED"
trap 'rm -f "$LOCK_STARTED"; rmdir "$LOCK" 2>/dev/null || true' EXIT INT TERM

# ---------------------------------------------------------------------------
# 5. Take the request away BEFORE doing the work.
#
# If the update fails, the request must be gone: otherwise the next cron run
# tries again, fails again, and the host rebuilds a broken tree every five
# minutes for as long as nobody notices. A failure is reported and waits for a
# human to press the button again.
# ---------------------------------------------------------------------------
rm -f "$REQUEST"

STARTED="$(now)"

# ---------------------------------------------------------------------------
# 6. The update itself: two fixed commands in one fixed directory.
#
# BUILD_COMMIT is read from the checkout AFTER the pull and handed to the build
# as an argument, so the running container can answer "which commit am I?".
# It comes from git in REPO_DIR — never from the request file.
# ---------------------------------------------------------------------------
#
# Chained with && rather than written as four lines: `set -e` does NOT apply
# inside the `if` below, so a failing `git pull` would otherwise fall through
# and build the old tree while reporting success.
update() {
  cd "$REPO_DIR" &&
  git pull --ff-only &&
  BUILD_COMMIT="$(git rev-parse --short HEAD)" &&
  export BUILD_COMMIT &&
  docker compose up -d --build
}

if OUTPUT="$(update 2>&1)"; then
  STATUS=ok
else
  STATUS=failed
fi

# ---------------------------------------------------------------------------
# 7. The result, for the tool to show. Output tail only — the end of a build
#    log is where the error is.
# ---------------------------------------------------------------------------
{
  printf 'status=%s\n' "$STATUS"
  printf 'started=%s\n' "$STARTED"
  printf 'finished=%s\n' "$(now)"
  printf -- '--- output ---\n'
  printf '%s\n' "$OUTPUT" | tail -c "$OUTPUT_KEEP_BYTES"
} | publish "$RESULT"

echo "poe-price-tool update: $STATUS (see $RESULT)"
[ "$STATUS" = ok ]
