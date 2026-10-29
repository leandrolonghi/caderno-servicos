"""Baixa a taxa Selic diária (série 11 do Banco Central) e grava selic.json.
O app usa esse arquivo para corrigir os aportes; sem sinal, usa a última cópia guardada."""
import json, time, urllib.error, urllib.request
from datetime import date

INICIO = 2020
ARQ = 'selic.json'
URL = 'https://api.bcb.gov.br/dados/serie/bcdata.sgs.11/dados?formato=json&dataInicial=01/01/{a}&dataFinal={fim}'


def baixar(ano):
    fim = f'31/12/{ano}' if ano < hoje.year else hoje.strftime('%d/%m/%Y')
    for tentativa in range(5):
        try:
            req = urllib.request.Request(URL.format(a=ano, fim=fim), headers={'User-Agent': 'controle-de-os (github.com/leandrolonghi/caderno-servicos)', 'Accept': 'application/json'})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            # começo de janeiro: o ano ainda não tem taxa publicada
            if e.code == 404 and ano == hoje.year:
                return []
            print(f'{ano}: tentativa {tentativa + 1} falhou ({e})')
            time.sleep(10 * (tentativa + 1))
        except Exception as e:
            print(f'{ano}: tentativa {tentativa + 1} falhou ({e})')
            time.sleep(10 * (tentativa + 1))
    raise SystemExit(f'Não consegui baixar a Selic de {ano}')


hoje = date.today()
try:
    with open(ARQ) as f:
        serie = json.load(f).get('serie', {})
except FileNotFoundError:
    serie = {}

# anos já completos no arquivo não mudam: baixa só o ano atual (e o anterior, na virada)
for ano in range(INICIO, hoje.year + 1):
    if ano < hoje.year - 1 and any(d.startswith(f'{ano}-12-') for d in serie):
        continue
    for x in baixar(ano):
        d, m, a = x['data'].split('/')
        v = float(x['valor'])
        if not 0 <= v < 0.2:
            raise SystemExit(f'Taxa estranha em {x}')
        serie[f'{a}-{m}-{d}'] = v

serie = dict(sorted(serie.items()))
with open(ARQ, 'w') as f:
    json.dump({'fonte': 'Banco Central do Brasil, SGS 11 (% ao dia)', 'ate': max(serie), 'serie': serie}, f, separators=(',', ':'))
    f.write('\n')
print(f'{len(serie)} dias, até {max(serie)}')
