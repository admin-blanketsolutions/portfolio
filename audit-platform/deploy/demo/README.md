# Hosted demo

One server runs the whole platform with a **synthetic** demo firm: the database, API, web app, TB parser, sign-in server (Keycloak) and an HTTPS front door (Caddy).

The demo firm is **Jordan Audit & Assurance (Demo)**. It has:
- four staff accounts: a partner, a manager, a senior and an associate;
- three clients, each with an FY2025 engagement;
- an 87-account IFRS chart of accounts in English and Arabic;
- sample trial balances to upload, in [`sample-tbs/`](sample-tbs).

> **Synthetic data only.** This profile keeps uploaded files in memory and parses them in a resource-limited process instead of the network-less container. Do not upload real client files. Production uses S3 with Object Lock and the container sandbox; see the main README, "Deploying".

> **No server yet?** [`browser-demo/`](browser-demo) is a single-page version of this demo, including the AI copilot. It runs in claude.ai with nothing to host, and comes with a [demo script](browser-demo/DEMO-SCRIPT.md).

## Addresses

With the domain `demo.blanketsolutions.net`:

| What | Address |
|---|---|
| The demo firm's app | `https://jordan-audit.demo.blanketsolutions.net` |
| Sign-in (Keycloak) | `https://login.demo.blanketsolutions.net` |

## Free hosting: Oracle Cloud "Always Free"

Oracle's Always Free tier includes a server with 4 ARM CPUs and 24 GB of memory at no charge, and it does not expire. The same steps work on AWS Lightsail later.

1. **Create the account.** Sign up at <https://cloud.oracle.com> (Free Tier).
   - A card is needed for verification only; it isn't charged.
   - Choose the **home region** carefully, because it can't be changed later and free ARM servers exist only there. *UAE East (Dubai)*, *Saudi Arabia West (Jeddah)* and *Germany Central (Frankfurt)* are sensible choices.
2. **Create the server.** Go to **Compute → Instances → Create instance**.
   - Image: **Ubuntu 24.04**.
   - Shape: **Ampere → VM.Standard.A1.Flex**, **4 OCPU / 24 GB**. This is within the free limits.
   - SSH keys: upload your public key, or let Oracle generate one and download it.
   - If Oracle says the shape is "out of capacity", retry later or pick another availability domain.
3. **Open ports 80 and 443 in Oracle's firewall.** Go to **Networking → Virtual cloud networks → (your VCN) → Security lists → Default**. Add two ingress rules, both with source `0.0.0.0/0` and protocol TCP: one for port **80**, one for port **443**.
4. **Point the DNS at the server.** Wherever `blanketsolutions.net`'s DNS is managed, add two **A records** pointing to the server's public IP:
   - `jordan-audit.demo` → public IP
   - `login.demo` → public IP

   Alternatively, add one wildcard record, `*.demo`, pointing to the same IP.
5. **Log in and install Docker.** SSH in with `ssh ubuntu@<public IP>`, then run:
   ```bash
   # Oracle's Ubuntu images also block ports in the server's own firewall:
   sudo iptables -I INPUT 6 -p tcp -m multiport --dports 80,443 -j ACCEPT
   sudo netfilter-persistent save
   curl -fsSL https://get.docker.com | sudo sh
   ```
6. **Get the code.** For a private repository, first create a read-only deploy key:
   - run `ssh-keygen -t ed25519 -f ~/.ssh/demo -N ''` on the server;
   - in GitHub, open **Settings → Deploy keys → Add deploy key** and paste the contents of `~/.ssh/demo.pub`.

   Then clone:
   ```bash
   GIT_SSH_COMMAND='ssh -i ~/.ssh/demo' git clone git@github.com:admin-blanketsolutions/portfolio.git
   cd portfolio/audit-platform/deploy/demo
   ```
7. **Configure.** Run `./setup.sh`. It asks for:
   - the domain, e.g. `demo.blanketsolutions.net`;
   - an e-mail address for the HTTPS certificates;
   - the Anthropic API key. Press Enter to skip it; AI mapping then stays off and firm rules and exact matches still work.

   It generates every other secret into `.env` and **prints the demo sign-in passwords**. Keep them, and keep `.env` private.
8. **Start everything:**
   ```bash
   sudo docker compose up -d --build
   ```
   - The first build takes about 10–15 minutes. Later starts take seconds.
   - HTTPS certificates are issued automatically once the DNS records point at the server.
9. **Open** `https://jordan-audit.demo.blanketsolutions.net`, click **Sign in**, and use one of the printed accounts.

### Running it day to day

| Task | Command (in `deploy/demo`) |
|---|---|
| Update to the latest code | `git pull && sudo docker compose up -d --build` |
| Reset the demo data (fresh firm, same passwords) | `sudo docker compose down -v && sudo docker compose up -d` |
| Stop it | `sudo docker compose down` |
| Look at logs | `sudo docker compose logs -f api` (or `web`, `keycloak`, `caddy`) |
| Change passwords or domain | `sudo docker compose down -v && rm .env && ./setup.sh && sudo docker compose up -d` |

The Keycloak admin console isn't published. If you need it, open an SSH tunnel with `ssh -L 8080:localhost:8080 …` and run `sudo docker compose exec keycloak …`.

## A suggested demo script (10 minutes)

1. **Sign in as Sara Nasser** (username `senior`). Point out the firm's own sign-in page, and that each firm has its own address and its own sign-in.
2. **Engagements**: three clients for FY2025. Switch to **العربية** at any point; the whole interface mirrors.
3. **Al-Nakheel Trading → Trial balance → Upload** `Al-Nakheel Trading - TB 31-12-2025.xlsx`. Within seconds:
   - lines matching the firm's chart or rules are suggested ("Exact match", "Firm rule");
   - with the API key, the AI suggests the rest, each with a one-line reason.
4. **Review**: filter "Needs review", then "Accept selected" for the unflagged suggestions. Open one AI suggestion to show the rationale, and map one line by hand, which asks for a reason for the audit trail.
5. **Arabic data**: on Petra Food Industries, upload the Arabic workbook. Arabic account names are read, matched and shown correctly.
6. **Security**: on Zahran Real Estate, upload `Security demo - suspicious account names.xlsx`:
   - two account names try to instruct the AI;
   - they're flagged, kept out of bulk accept, and can't be accepted without an explicit acknowledgement.
7. **Lock and statements**:
   - the associate (`junior`) can't lock; the senior can;
   - then open **Financial statements**: a balanced draft statement of financial position and statement of profit or loss, in English or Arabic.

## Local test on one machine

```bash
DEMO_DOMAIN=localhost ./setup.sh
docker compose up -d --build
```

Then open `https://jordan-audit.localhost`. The browser warns about the local certificate authority; that's expected in local mode.

`web/scripts/demo-smoke.mjs` and `web/scripts/demo-walkthrough.mjs` drive the steps above in a real browser. Set `DEMO_URL`, `DEMO_PASSWORD` and, in local mode, `DEMO_INSECURE_TLS=1`.
