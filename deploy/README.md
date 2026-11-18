# Deployment guide

The recommended production runtime is the Docker image defined in `docker-compose.yml`. It builds the web bundle and runs the Bun server with a persistent data volume. A compiled-binary option is available for hosts that prefer a supervisor-agnostic process.

## Docker deployment

Set the required secrets in a local `.env` file (never commit it), then start the stack:

```dotenv
# .env
CC_MASTER_KEY='<persistent master key>'
CC_ADMIN_PASSWORD='<admin password>'
# Or set CC_BOOTSTRAP_TOKEN and use the first-run setup form.
HOST=0.0.0.0
PORT=3030
```

```bash
docker compose up -d --build
```

The compose file mounts a named volume at `/data` and uses host network mode so wake-on-LAN broadcasts reach the LAN and units are reachable by IP. Keep `CC_MASTER_KEY` stable across restarts and back it up separately; it is not included in database backups.

Useful commands:

```bash
docker compose logs -f control-center
docker compose restart control-center
docker compose down
```

See [installation](../docs/installation.md) for the full environment reference and [operations](../docs/operations.md#backup-and-restore) for backup requirements.

## Compiled binary

Build the web bundle and executable:

```bash
bun run build
```

The binary reads the web bundle and agent scripts from disk, so set all three path variables explicitly:

```bash
CC_MASTER_KEY='<persistent master key>' \
CC_ADMIN_PASSWORD='<admin password>' \
HOST=0.0.0.0 PORT=3030 \
CC_DATA=<DATA_DIR> \
CC_WEB=<INSTALL_DIR>/apps/web/dist \
CC_AGENT_DIR=<INSTALL_DIR>/agent \
<INSTALL_DIR>/dist/control-center
```

Run the process under whatever supervisor your host already uses. The repository includes an **optional** systemd example in `examples/systemd/control-center.service`; it is one host-specific way to run the binary, not the default deployment path. Adapt it to your environment or ignore it.

## TLS and network exposure

The dashboard has a single admin login, but it is not a public multi-tenant service. Bind to loopback and terminate TLS at a reverse proxy when exposing it beyond a trusted network.

Do not commit `dist/`, `apps/web/dist/`, `data/`, or `.env`.
