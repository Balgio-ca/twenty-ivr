# twenty-ivr — Gio, la standardiste IA de Balgio

Serveur de reponse vocale interactive (IVR) avec une standardiste IA en francais
quebecois. Un appel entrant est pris en charge par **Gio**, un assistant
**virtuel et transparent** (il ne se fait jamais passer pour un humain), qui peut:

- prendre un message et capter les coordonnees d'un client potentiel;
- fixer un rendez-vous;
- transferer l'appel vers une personne de l'equipe;
- journaliser chaque appel dans **Twenty CRM** (contact, appel, rendez-vous, tache).

## Architecture

```
 Appelant ──► Numero Twilio ──► POST /twiml/voice ──► <Connect><ConversationRelay>
                                                              │  (websocket wss:/relay)
                                                              ▼
                                    Twilio gere la voix (STT + TTS fr-CA)
                                                              │
                                                              ▼
                                   twenty-ivr  ── Claude (agent + outils) ──► Twenty CRM
                                                              │
                          fin d'appel ──► POST /twiml/action ──► <Dial> (transfert) ou <Hangup>
```

- **Twilio ConversationRelay** convertit la parole en texte et le texte en voix
  (francais du Quebec) et relaie la conversation par websocket.
- **Claude** (Anthropic) tient le role de Gio et decide quand utiliser un outil.
- **Twenty CRM** (crm.agencebalgio.ca) recoit les donnees via son API REST.

## Prerequis (comptes et cles)

| Variable | Ou l'obtenir |
| --- | --- |
| `ANTHROPIC_API_KEY` | console.anthropic.com |
| `TWENTY_API_KEY` | Twenty > Parametres > API & Webhooks > cle API |
| `TWILIO_AUTH_TOKEN` | Console Twilio (Account Info) |
| Un numero Twilio | Console Twilio > Phone Numbers (idealement indicatif quebecois) |
| `HUMAN_TRANSFER_NUMBER` | Le numero (E.164) qui recoit les transferts |

## Installation

```bash
cd ~/twenty-ivr
npm install
cp .env.example .env   # puis remplis les valeurs
npm run build
npm start              # ou: npm run dev (rechargement a chaud)
```

Le service ecoute sur `PORT` (8080 par defaut) et expose:

- `POST /twiml/voice` — webhook voix de Twilio (retourne le TwiML ConversationRelay);
- `wss://.../relay` — le websocket de la conversation;
- `POST /twiml/action` — fin de session (transfert ou raccroché);
- `GET /health` — verification d'etat.

## Essai local (avant la mise en ligne)

Twilio doit joindre ton serveur par une URL publique **HTTPS/WSS**. En local,
ouvre un tunnel:

```bash
cloudflared tunnel --url http://localhost:8080
# ou
ngrok http 8080
```

Mets l'URL publique du tunnel dans `PUBLIC_BASE_URL` (ex.
`https://mon-tunnel.trycloudflare.com`), relance le service, puis configure le
numero Twilio (voir plus bas) sur `.../twiml/voice`.

## Configuration du numero Twilio

1. Console Twilio > Phone Numbers > ton numero.
2. Section **Voice Configuration** > *A call comes in* :
   - **Webhook**, `HTTP POST`, URL = `https://<ton-domaine>/twiml/voice`.
3. Sauvegarde, puis appelle le numero. Gio devrait repondre.

> ConversationRelay est active par ligne/compte chez Twilio. Si le TwiML
> `<ConversationRelay>` est refuse, active la fonctionnalite depuis la console
> Twilio (Voice > Settings) ou aupres du support.

## Voix francaise (fr-CA)

Reglages dans `.env` (attributs de `<ConversationRelay>`):

- `CR_LANGUAGE=fr-CA`
- `CR_TTS_PROVIDER=Google` et `CR_VOICE=fr-CA-Neural2-D` (voix masculine)
  - Alternatives Amazon Polly: `CR_TTS_PROVIDER=Amazon`, `CR_VOICE=Liam-Neural`.
- `CR_TRANSCRIPTION_PROVIDER=Google`

Laisse une variable vide pour utiliser le defaut de Twilio. Consulte la doc
Twilio pour la liste exacte des voix disponibles sur ton compte.

## Ce qui est ecrit dans Twenty

| Evenement | Objet Twenty | Champs cles |
| --- | --- | --- |
| Chaque appel | `calls` | `twilioCallSid`, `direction=INBOUND`, `phoneNumber`, `transcript`, `summary`, `outcome`, `personId` |
| Contact inconnu | `people` | `name`, `phones` (compose) |
| Rendez-vous | `meetings` (Rendez-vous) | `name`, `startsAt`, `endsAt`, `status=BOOKED`, `personId`, `attendeeEmail` |
| Message / rappel | `tasks` (+ `taskTargets`) | `title`, `bodyV2.markdown`, `status=TODO`, lien au contact |

Le contact est reconnu par son numero de telephone (`phones.primaryPhoneNumber`).
Si le CRM est injoignable, Gio continue l'appel a l'oral (degradation gracieuse)
et le probleme est journalise.

## Deploiement (production)

Options, de la plus simple a la plus integree:

1. **Meme serveur Hetzner que le CRM** (recommande) — derriere le reverse proxy
   existant, sur un sous-domaine `ivr.agencebalgio.ca` en HTTPS. Lance le service
   avec `pm2` ou un service `systemd`, puis pointe le proxy vers `PORT`.
2. **Railway / Render / Fly.io** — deploie le repo, definit les variables
   d'environnement, expose le port. `PUBLIC_BASE_URL` = l'URL fournie.

Exemple systemd (`/etc/systemd/system/twenty-ivr.service`):

```ini
[Service]
WorkingDirectory=/opt/twenty-ivr
ExecStart=/usr/bin/node dist/index.js
EnvironmentFile=/opt/twenty-ivr/.env
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

Le sous-domaine doit gerer la montee en websocket (`Upgrade`/`Connection` pour
`/relay`). Avec Nginx: `proxy_set_header Upgrade $http_upgrade;` et
`proxy_set_header Connection "upgrade";`.

## Personnalisation

- **Persona et regles** de Gio: `src/llm/prompt.ts`.
- **Outils** (message, rendez-vous, transfert, fin): `src/llm/tools.ts`.
- **Message d'accueil**: fonction `welcomeGreeting()` dans `src/twiml.ts`.
- **Mapping CRM**: `src/twenty/records.ts` et `src/twenty/people.ts`.

## Prochaines etapes possibles

- **Disponibilites reelles** pour les rendez-vous: brancher Cal.com (l'objet
  `meetings` est deja aligne sur Cal.com) pour verifier les creneaux et creer une
  vraie reservation au lieu d'un rendez-vous a confirmer.
- **Heures d'ouverture**: message different et transfert hors des heures.
- **Enregistrement** de l'appel et lien dans le champ `recordingUrl` de `calls`.
- **Courriel de confirmation** automatique apres un rendez-vous.
