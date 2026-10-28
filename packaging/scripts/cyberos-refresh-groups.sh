#!/bin/sh
set -eu

DROPIN_DIR=/etc/systemd/system/cyberos-api.service.d
DROPIN_PATH="$DROPIN_DIR/optional-groups.conf"
POLKIT_RULE_PATH=/etc/polkit-1/rules.d/49-cyberos-libvirt.rules

optional_groups=""
for optional_group in docker libvirt kvm; do
  if getent group "$optional_group" >/dev/null 2>&1; then
    optional_groups="$optional_groups $optional_group"
  fi
done

if [ -n "$optional_groups" ]; then
  install -d -m 0755 "$DROPIN_DIR"
  printf '[Service]\nSupplementaryGroups=%s\n' "${optional_groups# }" > "$DROPIN_PATH"
else
  rm -f "$DROPIN_PATH"
  rmdir "$DROPIN_DIR" 2>/dev/null || true
fi

# Debian's libvirt system URI defaults to polkit authentication. CyberOS has
# no desktop agent, so grant only its service account the required manage action
# when the optional libvirt group is present.
if getent group libvirt >/dev/null 2>&1; then
  install -d -m 0755 "$(dirname "$POLKIT_RULE_PATH")"
  cat > "$POLKIT_RULE_PATH" <<'EOF_POLKIT'
polkit.addRule(function(action, subject) {
  if (subject.user == "cyberos" && action.id == "org.libvirt.unix.manage") {
    return polkit.Result.YES;
  }
});
EOF_POLKIT
else
  rm -f "$POLKIT_RULE_PATH"
fi

if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload || true
fi
