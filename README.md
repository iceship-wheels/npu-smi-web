# NPU-SMI Monitor

Real-time NPU status dashboard with reservation queue. Polls hosts via SSH every 5s.

## Deploy

```bash
npm install
# Edit config.json with your hosts, then:
npm start
# Open http://localhost:8000
```

## Prerequisites

- Node.js ≥ 16
- SSH access from this server to each NPU host (password or key)
- `npu-smi` available on each host

## config.json

```json
{
  "port": 8000,
  "hosts": [
    {
      "name": "npu-01",
      "host": "192.168.1.100",
      "username": "root",
      "password": "xxx",
      "command": "npu-smi info -t 5"
    },
    {
      "name": "npu-02",
      "host": "192.168.1.101",
      "username": "root",
      "key_path": "/home/you/.ssh/id_rsa"
    }
  ]
}
```

Per host: `name`, `host`, `username` are required. Use either `password` or `key_path` for auth. `command` defaults to `npu-smi info -t 5`. `port` defaults to 22.

## Persistent Data

- `data/queue.json` — reservations
- `data/announcements.json` — per-host notices

Auto-created on first run.
