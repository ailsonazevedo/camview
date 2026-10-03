# CamView

Painel web local para assistir ao vivo as câmeras IP do app **ICSee** (XiongMai / XMeye).

```
Navegador (React)  ──▶  API Node (Fastify) :3001  ──▶  go2rtc :1984  ──DVRIP/RTSP──▶  câmeras
       └───────── vídeo via WebRTC/MSE (WebSocket /go2rtc/api/ws) ─────┘
```

- **go2rtc** puxa o vídeo da câmera por RTSP (554) — ou DVRIP (34567) — e entrega ao navegador por WebRTC (latência < 1s), com fallback para MSE/HLS. Não transcodifica, então quase não usa CPU.
- **server/**: cadastro das câmeras (`data/cameras.json`), teste de conexão, busca na rede, sincronização das streams com o go2rtc e **controle PTZ** via protocolo DVRIP/XMeye (`server/src/dvrip.ts`).
- **web/**: React + Vite + Tailwind. Mosaico ao vivo (stream SD), tela cheia (HD) com joystick PTZ.

### Câmeras de duas lentes

Modelos ICSee "fixa + móvel" (gun-ball) mandam **as duas imagens empilhadas no mesmo vídeo** (ex.: 2304×2592 = duas de 2304×1296). O CamView detecta isso pelo formato do quadro e mostra cada lente como um bloco separado. A lente móvel ganha o controle PTZ (segure as setas do joystick ou use as setas do teclado). Por padrão a móvel é a imagem de baixo — dá para trocar no cadastro.

### Interfone (ouvir e falar)

Na tela cheia, **Ouvir** libera o som da câmera e **Falar** manda o microfone do navegador para o alto-falante dela. O caminho é: microfone → WebRTC → go2rtc (stream `<id>_talk`) → intercomunicador DVRIP da câmera (G.711 A-law em blocos de 320 bytes).

- O navegador só libera o microfone em **https** ou **localhost**. Pelo celular via `http://IP:5173` o botão avisa que não dá. Para usar no celular, é preciso servir o painel por https (ex.: Tailscale com HTTPS).
- Se o app ICSee estiver com o áudio aberto, a câmera recusa uma segunda conversa.

### Mira por clique

As câmeras não informam a posição da lente móvel (o ONVIF delas devolve sempre `-1,-1`), e o comando nativo de "apontar" das câmeras de duas lentes não é documentado. Por isso a mira é feita **pela imagem**:

1. **Calibrar mira** (uma vez, ~30s): a lente móvel faz pequenos movimentos. O navegador mede quanto a imagem anda por segundo em cada sentido e procura a imagem móvel dentro da fixa. No fim, ela é guiada de volta à posição inicial comparando com a imagem de antes.
2. **Clique na lente móvel**: o ponto clicado vai para o centro, com uma correção conferida pela imagem.
3. **Clique na lente fixa** (*beta*): o painel acha onde a móvel está olhando dentro da fixa (um retângulo verde mostra isso) e a guia até o ponto, corrigindo em até 3 passos. Em texturas repetitivas (calçamento, grama) ou fora da área da fixa, pode não achar e avisa.

A aba precisa ficar **visível** durante a calibração e a mira: com ela escondida, o navegador pausa o vídeo.

### Por que RTSP e não DVRIP para o vídeo?

O leitor DVRIP do go2rtc descarta alguns codecs H.264 dessas câmeras (aparece `unsupported video codec: 82` no log e a HD abre sem imagem). Por RTSP o codec vem descrito no SDP e funciona. O DVRIP continua sendo usado para PTZ e para ler modelo/recursos.

## Rodando

Requisitos: Node 20+, macOS ou Linux, computador na mesma rede das câmeras.

```bash
npm run setup   # baixa o go2rtc para bin/ e instala dependências
npm run dev     # sobe go2rtc + API + front
```

Abra http://localhost:5173 (ou `http://IP-do-computador:5173` no celular/TV da mesma rede).

`npm start` faz o build do front e serve tudo pela porta 3001, sem o Vite.

## Conectando as câmeras do ICSee

1. Vá em **Câmeras → Procurar câmeras na rede**. As câmeras ICSee respondem ao broadcast de descoberta e aparecem com nome e número de série.
2. **Senha do dispositivo**: versões recentes do ICSee criam uma senha aleatória no pareamento. No app, abra a câmera → ⚙ → *Senha do dispositivo / Modificar senha* e defina uma senha sua. O usuário é normalmente `admin`. Não é a senha da sua conta ICSee.
3. Clique em **Adicionar**, informe a senha, clique em **Testar conexão** e salve.
4. Dica: reserve o IP de cada câmera no roteador (DHCP estático) para ele não mudar.

### Problemas comuns

| Sintoma | Causa / solução |
|---|---|
| "Usuário ou senha incorretos" | Defina/redefina a senha do dispositivo no ICSee. |
| A opção de senha não aparece no ICSee | A câmera foi compartilhada com sua conta (só o dono vê) ou o firmware esconde. Peça ao dono, ou resete a câmera e adicione de novo pela sua conta. |
| "Conta bloqueada" | Muitas tentativas erradas. Espere alguns minutos ou reinicie a câmera. |
| Teste OK, mas tela preta no navegador | A câmera provavelmente está em **H.265**. Troque para H.264 no ICSee (configuração de vídeo/codificação) ou use Safari / Chrome recente. |
| HD não abre | O teste de conexão tenta RTSP e DVRIP e adota o que funcionar; rode o teste e salve. |
| Não aparece nada na busca | O computador está em outra rede/VLAN, ou o Wi-Fi isola clientes. |

## Notas

- Funciona só na rede local. O acesso remoto do app ICSee usa a nuvem P2P proprietária da XMeye. Para ver de fora de casa, use uma VPN como o Tailscale até este computador.
- As senhas ficam em `data/` (fora do git): `cameras.json` e `go2rtc.yaml`. A API do go2rtc escuta só em `127.0.0.1`, e o proxy expõe apenas os endpoints de vídeo.
- O painel não tem login: qualquer pessoa na sua rede local que abrir a porta 5173/3001 consegue ver e gerenciar as câmeras.
