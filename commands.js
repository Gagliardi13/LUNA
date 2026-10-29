// Comandos que a Luna pode executar sozinha ou quando você pede por voz
// ("Luna, pisca pra mim", "muda o fundo pra azul", "tira os óculos").
import { setHair, setZoom } from './look.js';
import { MODOS } from './persona.js';

const CORES = {
  preto: '#000000', branco: '#f2f2f2', cinza: '#3a3a40', azul: '#1d2b4a', 'azul claro': '#5b86c5', marinho: '#0f1a33',
  verde: '#1f3b2c', vermelho: '#4a1418', vinho: '#3b0d1c', roxo: '#2b1a46', rosa: '#5a2a44', bege: '#c9b79c',
  marrom: '#3b2a20', laranja: '#b35a1f', amarelo: '#c9a227', dourado: '#8a6d2b',
};
const CABELO = {
  preto: '#141012', castanho: '#3d2a22', 'castanho claro': '#7a5236', loiro: '#c9a46a', 'loiro claro': '#e0c38e',
  ruivo: '#8c3a1e', grisalho: '#9a9a9a', vermelho: '#8a1a1a',
};
const EXPRESSOES = {
  piscar: '😉', beijo: '😘', sorriso: '😊', sorriso_de_canto: '😏', corar: '🥰', apaixonada: '😍',
  rir: '😂', surpresa: '😳', pensativa: '🤔', triste: '😔', revirar_olhos: '🙄', lingua: '😛',
};
const GESTOS = { acenar: 'handup', joinha: 'thumbup', ok: 'ok', dar_de_ombros: 'shrug', apontar: 'index', namaste: 'namaste' };
const HUMORES = { neutra: 'neutral', feliz: 'happy', apaixonada: 'love', seria: 'neutral', triste: 'sad', brava: 'angry' };

export const TOOLS = [
  {
    name: 'expressao',
    description: 'Faz uma expressão no rosto da Luna. Use sozinha quando combinar com o que ela diz (piscadinha num flerte, beijo ao se despedir) ou quando ele pedir.',
    parameters: { type: 'OBJECT', properties: { tipo: { type: 'STRING', enum: Object.keys(EXPRESSOES) } }, required: ['tipo'] },
  },
  {
    name: 'gesto',
    description: 'Faz um gesto com a cabeça ou com as mãos.',
    parameters: { type: 'OBJECT', properties: { tipo: { type: 'STRING', enum: ['sim', 'nao', ...Object.keys(GESTOS)] } }, required: ['tipo'] },
  },
  {
    name: 'mudar_fundo',
    description: 'Muda a cor do fundo da tela atrás da Luna.',
    parameters: { type: 'OBJECT', properties: { cor: { type: 'STRING', description: `nome da cor (${Object.keys(CORES).join(', ')}) ou código hex como #203040` } }, required: ['cor'] },
  },
  {
    name: 'mudar_cabelo',
    description: 'Muda a cor do cabelo da Luna.',
    parameters: { type: 'OBJECT', properties: { cor: { type: 'STRING', description: `nome (${Object.keys(CABELO).join(', ')}) ou código hex` } }, required: ['cor'] },
  },
  {
    name: 'oculos',
    description: 'Coloca ou tira os óculos da Luna.',
    parameters: { type: 'OBJECT', properties: { acao: { type: 'STRING', enum: ['colocar', 'tirar'] } }, required: ['acao'] },
  },
  {
    name: 'enquadramento',
    description: 'Aproxima ou afasta a câmera que mostra a Luna.',
    parameters: { type: 'OBJECT', properties: { distancia: { type: 'STRING', enum: ['bem_perto', 'perto', 'normal', 'longe'] } }, required: ['distancia'] },
  },
  {
    name: 'mostrar_comando',
    description: 'Mostra na tela dele um comando ou trecho de código pronto para copiar (com botão Copiar). Use SEMPRE que for passar um comando de terminal, um código, um arquivo (ex.: Dockerfile) ou um texto exato que ele precise digitar, em vez de soletrar.',
    parameters: {
      type: 'OBJECT',
      properties: {
        comando: { type: 'STRING', description: 'o comando ou código exato, pode ter várias linhas' },
        titulo: { type: 'STRING', description: 'título curto opcional, ex.: "Listar containers"' },
      },
      required: ['comando'],
    },
  },
  {
    name: 'mudar_modo',
    description: 'Muda o modo da conversa quando ele pedir: livre (conversa normal), desabafo (ouvinte acolhedora, estilo terapeuta), encontro (flerte e romance) ou professora (ensinar um assunto). Siga as instruções devolvidas.',
    parameters: { type: 'OBJECT', properties: { modo: { type: 'STRING', enum: Object.keys(MODOS) } }, required: ['modo'] },
  },
  {
    name: 'humor',
    description: 'Muda o humor de fundo do rosto da Luna por um tempo (ex.: apaixonada num momento romântico).',
    parameters: { type: 'OBJECT', properties: { estado: { type: 'STRING', enum: Object.keys(HUMORES) } }, required: ['estado'] },
  },
];

const cor = (v, tabela) => {
  const s = String(v || '').trim().toLowerCase().replace(/_/g, ' ');
  if (/^#[0-9a-f]{6}$/i.test(s)) return s;
  return tabela[s] || null;
};

// executa um comando; devolve um texto curto de resultado para a Luna
export function runCommand(name, args, ctx) {
  const { head, expression, setBackground, setMoodFor } = ctx;
  try {
    switch (name) {
      case 'expressao': {
        const e = EXPRESSOES[args.tipo];
        if (!e) return 'expressão desconhecida';
        expression(e);
        return 'feito';
      }
      case 'gesto': {
        if (args.tipo === 'sim' || args.tipo === 'nao') { expression(args.tipo === 'sim' ? 'yes' : 'no'); return 'feito'; }
        const g = GESTOS[args.tipo];
        if (!g) return 'gesto desconhecido';
        head.playGesture(g, 2.5);
        return 'feito';
      }
      case 'mudar_fundo': {
        const c = cor(args.cor, CORES);
        if (!c) return 'cor não reconhecida';
        setBackground(c);
        return 'fundo alterado';
      }
      case 'mudar_cabelo': {
        const c = cor(args.cor, CABELO);
        if (!c) return 'cor não reconhecida';
        setHair(head, c);
        return 'cabelo alterado';
      }
      case 'oculos': {
        if (head.glasses) head.glasses.visible = args.acao !== 'tirar';
        return args.acao === 'tirar' ? 'óculos tirados' : 'óculos colocados';
      }
      case 'enquadramento': {
        setZoom(head, { bem_perto: -0.9, perto: -0.5, normal: 0, longe: 0.9 }[args.distancia] ?? 0);
        return 'feito';
      }
      case 'mostrar_comando': {
        if (!args.comando) return 'comando vazio';
        ctx.showCommand?.(String(args.comando), args.titulo ? String(args.titulo) : '');
        return 'comando mostrado na tela dele, com botão Copiar';
      }
      case 'mudar_modo': {
        const m = MODOS[args.modo];
        if (!m) return 'modo desconhecido';
        ctx.onMode?.(args.modo);
        return `Modo alterado para "${m.nome}". A partir de agora siga isto (substitui o modo anterior): ${m.texto}`;
      }
      case 'humor': {
        setMoodFor(HUMORES[args.estado] || 'neutral', 15000);
        return 'feito';
      }
    }
  } catch (e) {
    return 'não consegui: ' + e.message;
  }
  return 'comando desconhecido';
}
