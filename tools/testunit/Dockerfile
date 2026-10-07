FROM debian:12-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server sudo curl ca-certificates procps && rm -rf /var/lib/apt/lists/* && mkdir -p /run/sshd
# systemctl shim: containers have no systemd; run the agent directly
RUN printf '#!/bin/sh\ncase "$1" in enable) su -s /bin/bash ccagent -c "nohup /opt/ccagent/ccagent.sh >/dev/null 2>&1 &" ;; is-active) echo active;; poweroff|reboot) echo "SIMULATED $1" >> /tmp/power.log;; esac\nexit 0\n' > /usr/bin/systemctl && chmod +x /usr/bin/systemctl
RUN printf '#!/bin/sh\nexit 0\n' > /usr/bin/systemd-tmpfiles && chmod +x /usr/bin/systemd-tmpfiles
CMD ["/usr/sbin/sshd","-D","-e"]
