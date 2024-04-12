import express from "express";
import { default as API_KEYS } from "../api-keys.json" with { type: "json" };


const app = express();
app.use(express.static("www"));
app.use(express.json()) // for parsing req.body when mine type is application/json

// Utils

async function request(endpoint, method = "get", params, apiKey) {
  const options = { method, headers: { "Content-Type": "application/json" }};
  if (apiKey) {
    options.headers["Authorization"] = `Bearer ${apiKey}`;
  }
  if (params) {
    options['body'] = JSON.stringify(params);
  }

  const response = await fetch(endpoint, options);
  return await response.json();
}

const CONFIG = {
  ollama: {
    // endpoint: "http://localhost:11434/api/generate",
    endpoint: "https://9kk0fjnthrlwss-11434.proxy.runpod.net/api/generate",
  }
}

const OLLAMA = {
  chat: async (options) => (await request(CONFIG.ollama.endpoint, "post", { model: "openhermes", stream: false, ...options })).response,
}


// 3rd party APIs function calls

const FUNCTION_CALLS = {
  // Open-Notify: ISS location and people in space
  getISSLocation: async () => await request("http://api.open-notify.org/iss-now.json"),
  getPeopleInSpace: async () => await request("http://api.open-notify.org/astros.json")
};

function parseFunctionCall(call) {
  const [name, params] = call.split("(");
  return { name, params: params.replace(")", "").split(",") };
}

// Proxy Endpoints

app.get("/function/call", async (req, res) => {
  console.log("GET /function/call")
  // const query = "How many people are currently in space and what are their names?";
  const query = "What is the current position of the International Space Station?";

  let answer = await OLLAMA.chat({ prompt: `Instructions:\
Answer the user query without guessing. If you don't have enough information, call some of the following Javascript functions by returning only "Call: <name of the function to call>(<function parameters if any>)":\
\
/**\
 * Return the number and name of people currently in space\
 * Args: none\
 * Returns { number: int, people: [ { name: string, craft: string } ] }\
 */\
function getPeopleInSpace()\
\
/**\
 * Return the current location of the International Space Station\
 * Args: none\
 * Returns { timestamp: int, iss_position: { latitude: float, longitude: float } }\
 */\
function getISSLocation()\
\
User Query: ${query}`
  });
  
  console.log('initial answer', { answer })
  if (answer.startsWith("Call:")) {
    console.log('function calling request detected');

    const callRequest = answer.split(":")[1].trim();
    const { name, params } = parseFunctionCall(callRequest);
    const callFunction = FUNCTION_CALLS[name];

    console.log('function calling details', name, params, callFunction);

    // NOTE: eval() is risky if poorly formatted arguments or function halucinated
    // const data = await eval(callRequest);
    
    if (!callFunction) {
      res.json({ error: `Function ${name}(${params.join(", ")}) not found` });
      return;
    }
    
    const data = await callFunction.apply(params);

    console.log('data from function calling', data.number, data.people)

    answer = await OLLAMA.chat({ model: 'openhermes', prompt: `Instructions:\
Here is the result of the function ${name}(${params.join(", ")}) that you requested earlier to answer the user query: ${JSON.stringify(data)}\
Leverage this result in your answer, but do not mention the function name or parameters.\
\
User Query: ${query}`
    })
  }

  res.json({ answer })
});

app.listen(8000, () => console.log("Server running on http://localhost:8000\nHave you updated the RunPod proxy URL in the CONFIG object?"));
