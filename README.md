# Free LLM Dashboard

Web dashboard to interact with free tier providers. 
Currently integrated with:
- Cerebras
- Gemini
- GitHub Models
- Groq
- Local MLX (opt-in, via `mlx_lm.server`)
- Sambanova

**NOTE: This dashboard is free, local software. LLM providers have their own terms. Treat anything you send out as public data.**

## Usage

```
cp .env.example .env

vi .env

-> go get / add API keys

npm run build

npm run dashboard

-> htts://localhost:3000
```

## License

[GPLv3](https://www.gnu.org/licenses/gpl-3.0.en.html)