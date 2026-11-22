# Skyglass: start the phone UI on the touchscreen (tty1). SSH/other ttys get a normal shell.
[ -f ~/.bashrc ] && . ~/.bashrc
if [ "$(tty)" = "/dev/tty1" ] && [ -z "$WAYLAND_DISPLAY" ] && [ -z "$SKYGLASS_FAILED" ] && [ ! -e ~/.skyglass-console ]; then
  exec /usr/local/bin/skyglass-session
fi
