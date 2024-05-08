# Function Calling

Leverage dynamic data from 3rd party APIs in your AI model answers.

Requirements:
- an [OpenAI API account](https://platform.openai.com/account/organization) & API key (for GPT4 model)
- a free Tomorrow.io account & API key (for Weather API call),

And/or
- [Ollama](https://ollama.ai) running locally (for Mistral 7B Instruct and Hermes 2 Pro Mistral 7B),


## Getting started

1. Setup and start the UI with the following commands:
```
npm install
echo '{ "OPENAI": "<YOUR API KEY HERE>", "TOMORROW_IO": ""<YOUR API KEY HERE>" }' > api-keys.json
npm start
```
2. Visit http://localhost:8000/ with your browser
3. Enter a question about who is in space, or what city or weather the International Space Station is flying over.
4. Change the model as needed.


## Architecture

```
     /www/index.html                     (basic UI)
       |
       | click Send
       v
     /www/index.js                       (event handlers for basic UI)
       |
       | POST prompt & model
       v
     /src/proxy.js                       (proxy request to AI model hosting provider)
       |
       | POST chat request
       v
+--> AI model hosting provider           (e.g. OpenAI, Ollama...)
|      |
|      | return chat response
|      v
|    /src/proxy.js
|      |
|      v
|    function call requested ?
|      |                 | 
|      | yes             | no
|      v                 | 
|  external API          |
|      |                 |
|      |                 |
|      v                 v
+--- /src/proxy.js    /src/proxy.js
                         |
       +-----------------+
       | return entire conversation
       v
     /www/index.js
       |
       | append conversation to DOM
       v
     /www/index.html
```
