# Controle de OS

App de ordens de serviço da Longhi Soluções Agrícolas. Funciona no celular, tablet e computador, inclusive sem sinal: tudo fica guardado no aparelho e é enviado para a nuvem quando a conexão volta.

- `index.html`: o app
- `nuvem.js`: login e sincronização com o Supabase
- `conta.js`: tela de entrada, sair da conta e instalação
- `sw.js`: guarda o app no aparelho para abrir sem internet
- `notafiscal.js`: lê a nota fiscal anexada em Gestão › Gastos (foto, PDF ou XML) no próprio aparelho e preenche fornecedor, data, número, chave de acesso e valor. Reconhece NF-e/DANFE (peças), NFC-e, CF-e SAT e NFS-e (DANFSe nacional, chave de 50 dígitos): lê o nome e o CNPJ no quadro do emitente/prestador, nunca no do destinatário/tomador, confere número, CNPJ e mês com a chave e deixa em branco o que não bate. A foto não sai do aparelho; com internet o nome do fornecedor novo é buscado pelo CNPJ (BrasilAPI)
- `vendor/nf/`: bibliotecas do leitor de notas (pdf.js, zxing-wasm e Tesseract.js com português), com as licenças. O `sw.js` guarda numa cache própria para ler notas sem internet
- `config.js`: endereço e chave pública do projeto Supabase
- `selic.json`: taxa Selic diária do Banco Central, usada para corrigir os aportes (Gestão › Aportes). Atualizada sozinha todo dia por `.github/workflows/selic.yml`
- `supabase/configurar.sql`: cria a tabela e a pasta de fotos no Supabase (rodar uma vez)
- `portal/`: leva para o portal do cliente, que fica em https://longhimanutencoes.github.io (repositório longhimanutencoes/longhimanutencoes.github.io)
- `supabase/portal.sql`: libera essa página no Supabase (rodar uma vez)

Publicado pelo GitHub Pages (Settings › Pages › branch `main`, pasta `/`).
