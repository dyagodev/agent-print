# Kero Pedir — Agente Local de Impressão

Roda no PC do restaurante. Faz polling na API e imprime automaticamente quando chegam pedidos novos.

## Requisitos

- Node.js 18+
- Impressoras configuradas no painel (Configurações → Estações de Impressão)

## Instalação

```bash
cd print-agent
npm install
```

## Uso

Na primeira execução, passe URL e token:

```bash
node agent.js --url=https://seusite.com.br --token=SEU_TOKEN_SANCTUM
```

A config fica salva em `~/.kero-print.json`. Nas próximas execuções basta:

```bash
node agent.js
```

## Gerar o token

1. No painel, acesse Configurações → API Tokens (ou peça ao admin)
2. Crie um token Sanctum para o usuário lojista
3. Copie e cole em `--token=`

## Impressoras em rede (TCP/IP)

Configure no painel: tipo = "Rede", IP e porta (padrão 9100).

## Impressoras USB (sem rede)

Configure no painel: tipo = "USB", Nome do SO.

- **Windows**: nome da impressora como aparece em "Dispositivos e Impressoras"
- **Linux/Mac**: nome como aparece em `lpstat -p`

## Iniciar automaticamente (Windows)

Crie um atalho para `agent.js` na pasta:
```
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
```

Ou use o agendador de tarefas para executar `node C:\caminho\print-agent\agent.js`.

## Iniciar automaticamente (Linux/Mac)

Crie um serviço systemd ou use pm2:

```bash
npm install -g pm2
pm2 start agent.js --name kero-print
pm2 save
pm2 startup
```
