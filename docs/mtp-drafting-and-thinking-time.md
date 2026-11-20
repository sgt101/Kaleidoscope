# Driving a local Qwen model with an MTP draft head, and limiting its thinking by time

Notes for reusing this in another project. They describe what Kaleidoscope does, why, and the traps found along the
way. They are written so that a coding assistant can rebuild the behaviour from them; the Kaleidoscope source is
cited where it helps (`providers.js`, `assistant.js`, `server.js`, `public/app.js`).

## The two ideas in one paragraph

A local 27B Qwen model is served with **speculative decoding**, using the model's own **multi-token prediction (MTP)**
head as the draft model: the head cheaply guesses a few tokens ahead and the full model checks all the guesses in one
forward pass, so several tokens can come out for the price of one pass. The model can also **think** (write reasoning
before its answer). The server can cap thinking by token count, but **refuses to while a draft model is running**. So
the client caps thinking **by wall-clock time** instead: when the time is up and no answer has started, it aborts the
request and asks again with thinking turned off, handing the model its unfinished reasoning as notes to answer from.

## 1. The serving set-up

| Thing | Value used |
|---|---|
| Server | `mlx_vlm.server` from [mlx-vlm](https://github.com/Blaizzy/mlx-vlm) 0.7.4, installed with `uv tool install mlx-vlm` (Apple silicon) |
| Main (target) model | `mlx-community/Qwen3.8-27B-4bit` |
| Draft model | `mlx-community/Qwen3.8-27B-MTP-4bit`: the MTP head only, which runs on the main model's hidden state |
| API | OpenAI-compatible: `POST http://127.0.0.1:8081/v1/chat/completions`, streamed as server-sent events |

```bash
mlx_vlm.server --model mlx-community/Qwen3.8-27B-4bit \
  --draft-model mlx-community/Qwen3.8-27B-MTP-4bit --draft-kind mtp \
  --host 127.0.0.1 --port 8081
```

How the drafting works, per round: the MTP head proposes a short block of tokens from the main model's last hidden
state; the main model runs one forward pass over the whole block; tokens are accepted up to the first one the main
model disagrees with, and the main model's own token is added at that point. The result is the main model's text, made
faster. It is invisible to the client: the API and the stream are the same as without a draft model. Why an MTP head
drafts well: it was trained with the main model and reads its internal state, so its guesses usually match.

Server behaviour that matters (mlx-vlm 0.7.4; check again for other versions or servers):

- **Thinking is off unless asked for.** Send `"enable_thinking": true` per request (server default: off; the
  `MLX_VLM_ENABLE_THINKING` environment variable changes it).
- **Temperature defaults to 0.** Send the model card's recommended sampling settings yourself.
- **`thinking_budget` is rejected with a draft model.** A request carrying it fails with
  `thinking_budget is not supported with speculative decoding in the server.` The server also fills it in from
  `--thinking-budget` / `MLX_VLM_THINKING_BUDGET` if those are set, so leave both unset. Structured output
  (`response_format`) is also refused with a draft model.
- **Reasoning streams apart from the answer**, in `choices[0].delta.reasoning` (some servers use
  `delta.reasoning_content`; read both). The answer comes in `delta.content`. Other servers put reasoning inline as
  `<think>…</think>` inside `content`; handle that too.
- **`max_tokens` covers thinking and answer together.** Ten minutes of thinking is several thousand tokens; 32768 was
  set so a long think cannot use up the limit before the answer.
- **Requests queue.** One request generates at a time, so a test request waits behind a real one.

## 2. The request

Per request, the client sends the usual chat fields plus one of two sets of extra fields, depending on whether
thinking is on. In Kaleidoscope these live in the provider's config, so nothing about Qwen is hard-coded:

```json
"thinking": {
  "on":  { "enable_thinking": true,  "temperature": 1.0, "top_p": 0.95, "top_k": 20 },
  "off": { "enable_thinking": false, "temperature": 0.7, "top_p": 0.8,  "top_k": 20, "presence_penalty": 1.5 }
}
```

The sampling values are Qwen's published recommendations for each mode; take them from the card of the model you
use. Build the body as `{model, messages, stream: true, max_tokens, ...thinking[on ? "on" : "off"]}`, and do not let
the config overwrite the fields the client owns (`model`, `messages`, `stream`, `max_tokens`).

## 3. The time limit

Inputs: the conversation, a time limit `T` seconds (0 = no thinking; Kaleidoscope's dial goes 0 to 600 in steps of
30), and the user's own cancel signal.

```
attempt(conversation, thinking = T > 0):
    request = new abort controller, also aborted if the user cancels
    reasoning = ""            # reasoning text received so far
    answer = ""               # visible answer text received so far
    timeUp = false
    stream the request with thinking fields for `thinking`:
        on reasoning delta d:
            reasoning += d
            on the FIRST reasoning delta: tell the UI "thinking, T seconds";
                if thinking and T > 0: start timer(T): if answer is empty: timeUp = true; request.abort()
        on answer delta d:
            answer += d;  cancel the timer (the answer has begun: let it finish);  show d
    if it ended normally: return answer
    if it was aborted and timeUp and the user did not cancel:
        tell the UI "out of time to think, writing the answer"
        return attempt(withNotes(conversation, reasoning), thinking = false)
    otherwise: re-raise (user cancel, network error, server error)

withNotes(conversation, notes):
    append to the LAST USER MESSAGE:
        "Your time to think has run out. Your thinking so far is below: answer now, using it,
         in the form asked for above.\n<thinking>\n" + last 60000 chars of notes + "\n</thinking>"
    (with no notes: "Your time to think has run out: answer now, in the form asked for above.")
```

Points that are easy to get wrong:

1. **Start the clock at the first reasoning token, not when the request is sent.** With a long prompt, the server can
   spend a minute or more reading it before the first token, and that time is not thinking.
2. **Stop the clock when answer text appears.** A model that has started its answer must be allowed to finish.
3. **Tell the timeout from a user cancel.** Both abort the same request; only the timeout leads to the second attempt.
   Link the user's signal to a per-attempt controller rather than reusing it.
4. **Aborting must reach the server.** Closing the HTTP stream is the only stop signal the client has; any proxy in
   between must pass the close on. Check that your server really stops generating on a closed stream (watch its GPU
   use or log), or it keeps thinking and the second attempt queues behind it.
5. **The second attempt is a new request with thinking off,** not a continuation. The notes go in the user message
   rather than as a prefilled assistant turn, because OpenAI-style chat APIs do not reliably support continuing an
   assistant message, and with thinking off the template would not expect a thinking block there anyway.
6. **Keep the end of the notes if they are long:** the latest reasoning is closest to an answer.
7. **The cost:** the second attempt reads the whole prompt again before answering. Expect a pause after "out of time".
8. **With no thinking config, send nothing.** A provider with no `thinking` entry gets no thinking fields at all and no
   dial; its own defaults stand.

Events Kaleidoscope's server streams to its browser (NDJSON), as a model for a UI:
`{type:"thinking", seconds}` once when thinking starts (`seconds` 0 = no limit), `{type:"text", text}` for answer
text, `{type:"thinking-over"}` when the time ran out, plus `done` and `error`. The browser shows
"Model is thinking… 0:42 of 2:00", counted locally each second from the `thinking` event.

## 4. Testing it without the real model

The real model is slow and serves one request at a time, so test against a stand-in: a tiny HTTP server that answers
`/v1/chat/completions` with an SSE stream. When the request has `"enable_thinking": true`, it sends reasoning
chunks until the connection closes. When thinking is off, it answers in `delta.content`, saying whether the last user
message carried a `<thinking>` block, so the test can see the notes arrived. The one Kaleidoscope used (Node, no
dependencies):

```js
const http = require('http');
http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
        const sent = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const send = (delta) => res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
        if (sent.enable_thinking) { // thinks until the client gives up
            const pulse = setInterval(() => send({ reasoning_content: 'hmm ' }), 300);
            return res.on('close', () => clearInterval(pulse));
        }
        const notes = /<thinking>/.test(sent.messages.at(-1).content) ? ' (from my notes)' : '';
        send({ content: `Yes${notes}.` });
        res.end('data: [DONE]\n\n');
    });
}).listen(18124, '127.0.0.1');
```

Then check:

- with `T = 30`: a `thinking` event, an abort at about 30 s, a `thinking-over` event, then an answer that contains
  the notes;
- with `T = 0`: the request carries `enable_thinking: false` and no `thinking` event appears;
- a user cancel during thinking: no second attempt;
- a provider without thinking config: no thinking fields in the body;
- reasoning given inline as `<think>…</think>` is detected and passed on as notes.

## 5. Prior work

Stopping a model's thinking and forcing it to answer is an established technique; what is particular here is doing it
by wall-clock time from the client, by restarting rather than continuing the generation, because the server will not
cap thinking during speculative decoding.

Forcing the answer:

- Muennighoff et al., **"s1: Simple test-time scaling"** (2025), [arXiv:2501.19393](https://arxiv.org/abs/2501.19393).
  Introduces *budget forcing*: end the thinking at a budget by appending the end-of-thinking delimiter so the model
  answers, or lengthen it by appending "Wait".
- Qwen Team, **"Qwen3 Technical Report"** (2025), [arXiv:2505.09388](https://arxiv.org/abs/2505.09388). Describes
  Qwen3's thinking budget: at the budget, the thinking is cut off and the model answers from the partial reasoning. The
  [Qwen quickstart](https://qwen.readthedocs.io/en/stable/getting_started/quickstart.html) shows doing it by inserting
  an early-stopping sentence and `</think>`.
- Ma et al., **"Reasoning Models Can Be Effective Without Thinking"** (2025),
  [arXiv:2504.09858](https://arxiv.org/abs/2504.09858). *NoThinking*: prefill an empty thinking block so the model
  answers directly; competitive with thinking at low budgets. The basis for the "thinking off" second attempt being
  reasonable.
- Yang et al., **"Dynamic Early Exit in Reasoning Models"** (DEER, 2025),
  [arXiv:2504.15895](https://arxiv.org/abs/2504.15895). Stops thinking at transition points, has the model write a
  trial answer from its partial reasoning, and exits early when the answer is confident.
- Server implementations of a token budget that force `</think>`:
  [SGLang](https://lmsysorg.mintlify.app/docs/advanced_features/thinking_budget),
  [FastDeploy](https://paddlepaddle.github.io/FastDeploy/features/thinking_budget), and llama.cpp's
  `--reasoning-budget`.

Multi-token prediction and speculative decoding:

- Leviathan, Kalman and Matias, **"Fast Inference from Transformers via Speculative Decoding"** (ICML 2023),
  [arXiv:2211.17192](https://arxiv.org/abs/2211.17192). A small model drafts, the large model verifies in parallel,
  and the output distribution is unchanged.
- Chen et al., **"Accelerating Large Language Model Decoding with Speculative Sampling"** (DeepMind, 2023),
  [arXiv:2302.01318](https://arxiv.org/abs/2302.01318). The same idea, developed independently.
- Gloeckle et al., **"Better & Faster Large Language Models via Multi-token Prediction"** (ICML 2024),
  [arXiv:2404.19737](https://arxiv.org/abs/2404.19737). Trains extra heads to predict several future tokens and uses
  them for self-speculative decoding (up to 3x faster).
- DeepSeek-AI, **"DeepSeek-V3 Technical Report"** (2024), [arXiv:2412.19437](https://arxiv.org/abs/2412.19437). An MTP
  module used as the draft for speculative decoding: 85–90% acceptance of the second token, about 1.8x tokens per
  second.
