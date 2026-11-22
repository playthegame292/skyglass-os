# Skyglass OS shell niceties + easter eggs
[ -n "$BASH_VERSION" ] || return 0
alias please='sudo'
alias ll='ls -lah --color=auto'
sudo() {
  if [ "$*" = "make me a sandwich" ]; then echo "Okay. 🥪  (no password needed — this is Skyglass)"; return 0; fi
  if [ "$*" = "rm -rf /" ] || [ "$*" = "rm -rf / --no-preserve-root" ]; then
    echo "Nice try. The bubbles have been notified. 🫧"; return 1
  fi
  command sudo "$@"
}
if [ -n "$SKYGLASS_TERM" ] || [ "$(tty 2>/dev/null)" != "/dev/tty1" ]; then
  PS1='\[\e[38;5;39m\]\u\[\e[0m\]@\[\e[38;5;77m\]skyglass\[\e[0m\]:\[\e[38;5;117m\]\w\[\e[0m\]\$ '
fi
# greet new Terminal-app sessions
[ -n "$SKYGLASS_TERM" ] && [ -z "$SKYGLASS_GREETED" ] && export SKYGLASS_GREETED=1 && command -v skyfetch >/dev/null && skyfetch && echo -e "\e[2mtry: aero · hack · sudo make me a sandwich\e[0m"
