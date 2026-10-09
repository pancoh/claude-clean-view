# Clean View

Mod para o Claude Code que deixa o trabalho do Claude mais calmo de acompanhar, sem a parte técnica.

Com o Clean View ligado:

- as chamadas de ferramentas, os diffs de arquivos e a saída de comandos ficam escondidos;
- as respostas escritas do Claude continuam visíveis;
- um checklist acima do prompt mostra o plano, a etapa atual e quanto falta.

```
Criar minha página inicial · 1m 12s
✓ Ler suas anotações da marca       ██████████  Feito
▶ Criar a seção de preços           ██████░░░░  60%
○ Adicionar o formulário de contato ░░░░░░░░░░  Próximo
○ Ajustar o rodapé                  ░░░░░░░░░░  Depois
```

O cabeçalho muda conforme o estado: **Precisa de você** (um pedido de permissão ou uma pergunta), **Travado** (um erro ou uma etapa recusada), **Parado** (você apertou Esc) e **Tudo pronto** (o trabalho terminou; 5 segundos depois, a faixa encolhe para uma linha).

## Instalação

No Claude Code, num terminal, digite um comando de cada vez no prompt:

```
/plugin marketplace add pancoh/claude-clean-view
/plugin install clean-view@clean-view
```

Não é preciso conta no GitHub. O mod foi testado no Claude Code 2.1.295.

Para atualizar: `/plugin update clean-view@clean-view`.

Para desinstalar: `/plugin uninstall clean-view@clean-view`. Se quiser remover também o marketplace: `/plugin marketplace remove clean-view`.

## Como usar

- Clique em **● clean view**, no canto direito abaixo do prompt, para desligar. Outro clique liga de novo.
- Ou use `/simple off`, `/simple on`, ou só `/simple` para alternar.
- A escolha fica salva entre sessões. O Clean View começa ligado.

## O que saber antes de instalar

- **Uso do seu plano:** a cada pedido, o mod faz uma chamada curta ao Haiku para dar nome ao trabalho, acrescenta uma instrução ao prompt de sistema e pede ao Claude chamadas extras para publicar o plano e o progresso.
- **Plano primeiro:** enquanto o Clean View está ligado, o Claude só usa ferramentas depois de publicar um plano.
- **Menos visibilidade:** você deixa de ver os arquivos que o Claude edita e os comandos que ele roda. Os pedidos de permissão continuam aparecendo. Para ver tudo, desligue com `/simple off`.

## Desenvolvimento

```
claude plugin validate .
claude plugin test .
```
