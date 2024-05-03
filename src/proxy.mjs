import OpenAI from "openai";
import express from "express";
import { Ajv } from "ajv";
import { default as API_KEYS } from "../api-keys.json" with { type: "json" };

const openai = new OpenAI({ apiKey: API_KEYS.OPENAI });


const app = express();
app.use(express.static("www"));
app.use(express.json()) // for parsing req.body when mine type is application/json

// Utils

async function request(endpoint, method = "get", params, apiKey) {
console.debug('request', endpoint, method, params, apiKey);
  const options = { method, headers: { "Content-Type": "application/json" }};
  if (apiKey) {
    options.headers["Authorization"] = `Bearer ${apiKey}`;
  }
  if (params) {
    options['body'] = JSON.stringify(params);
  }

  const response = await fetch(endpoint, options);
  const data = await response.json();
console.debug('response', data);
  return data;
}

const CONFIG = {
  OLLAMA: {
    ENDPOINT: process.env.RUNPOD_ID ? `https://${process.env.RUNPOD_ID}-11434.proxy.runpod.net/v1/chat/completions` : "http://localhost:11434/api/generate",
  }
}

const OLLAMA = {
  chat: async (options) => {
    const response = await request(CONFIG.OLLAMA.ENDPOINT, "post", { model: "openhermes", stream: false, ...options });
    return response.choices[response.choices.length - 1].message.content;
  },
}

const formatGPT4Tools = () => Object.entries(FUNCTION_CALLS).map(([name, data]) => ({
  type: "function",
  function: {
    name,
    description: data.schema.description
}}));

const formatHermes2Functions = () => Object.entries(FUNCTION_CALLS).map(([name, data]) => JSON.stringify({
  title: name,
  type: 'function',
  ...data.schema
})).join("\n");

const sanitizeToolcall = match => console.debug({tool_call: match[1]}) || JSON.parse(match[1].replace(/\n/, "").trim().replace(/'/g, "\"").replace(/arguments/, "properties"));

const callOllama = async (model, messages, abortAfter = 5) => {
  if (abortAfter <= 0) {
    // if parameters aren't passed properly to external APIs, the conversation can get into an endless loop
    return messages;
  }

  // call AI model with user prompt and previous messages
  let response = await OLLAMA.chat({ model, messages });
console.debug('assistant response', response);

  // log response
  messages.push({ role: "assistant", content: response });

  try {
    // check if response requests some function call(s)
    const toolCalls = [...response.matchAll(/<tool_call>\n(.*?)\n<\/tool_call>/gs)].map(sanitizeToolcall);
  
    if (toolCalls.length) {
      while (toolCalls.length) {
        const { name, properties } = toolCalls.shift();

        const callFunction = FUNCTION_CALLS[name];

        if (!callFunction) {
          // log error for the model to consider
          messages.push({ role: "user", content: JSON.stringify({ error: { type: "function check", message: `Function ${name} not found` } }) });
          continue;
        }

        if (!callFunction.validate(properties)) {
          // log error for the model to consider
          messages.push({ role: "user", content: JSON.stringify({ error: { type: "arguments check", message: callFunction.validate.errors } }) });
          continue;
        }
        // execute function call
// TODO this passes arguments positionally, but the function call schema may have them in a different order. Would be best to make callbacks accept an object instead.
        response = await callFunction.callback.apply(null, Object.values(properties));
  
        // log response
        messages.push({ role: "user", content: JSON.stringify(response) });
      }
  
      // call AI model again with function call responses
      messages = await callOllama(model, messages, abortAfter - 1);
    }
  } catch (e) {
    // log error for the model to consider
    messages.push({ role: "user", content: JSON.stringify({ error: { type: e.name, message: e.message } }) });
  }

  // no more function call(s) needed, return the whole conversation with the assistant's final answer
  return messages;
}


// 3rd party APIs function calls

const FUNCTION_CALLS = {
  // Open-Notify: ISS location and people in space
  getISSLocation: {
    callback: async () => await request("http://api.open-notify.org/iss-now.json"),
    schema: {
      description: "Get the current location of the International Space Station",
      properties: {},
      required: []
    }
  },
  getPeopleInSpace: {
    callback: async () => await request("http://api.open-notify.org/astros.json"),
    schema: {
      description: "Get the number and name of people currently in space",
      properties: {},
      required: []
    }
  },
  // Nominatin API: Reverse Geocoding
  getCityByCoordinates: {
    callback: async (lat, long) => await request(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${long}&format=json&zoom=10`),
    schema: {
      description: "Get the city, county, state and country by latitude and longitude coordinates",
      properties: {
        lat: { type: 'number' },
        long: { type: 'number' }
      },
      required: ['lat', 'long']
    }
  },
  // Tomorrow.io: Realtime weather data
  getWeatherByCoordinates: {
    callback: async (lat, long) => await request(`https://api.tomorrow.io/v4/weather/realtime?location=${lat},${long}&units=metric&apikey=${API_KEYS.TOMORROW_IO}`),
    schema: {
      description: "Get the temperature and weather code by latitude and longitude coordinates",
      properties: {
        lat: { type: 'number' },
        long: { type: 'number' }
      },
      required: ['lat', 'long']
    }
  }
};

// precompile a schema validator for each public API function call
const jsonValidator = new Ajv();
Object.values(FUNCTION_CALLS).forEach(func => func.validate = jsonValidator.compile(func.schema));


// Proxy Endpoints

app.post("/function/call", async (req, res) => {
  const { model, prompt } = req.body;

  let messages = [];
  let error;
  let response;
 
  switch(model) {
    case "gpt4":
      // TODO rewrite this in the model of callOllama
      messages.push({
        role: "system",
        content: "You are a assistant helping users to get an answer to their query. You do not guess, and call functions to get the information you need to answer the query."
      }, {
        role: "user",
        content: prompt
      })

      response = await openai.chat.completions.create({ model: "gpt-4-turbo-preview", messages, tools: formatGPT4Tools() });
      messages.push(response.choices[0].message);

      if (response.choices[0].finish_reason === "tool_calls") {
        const toolCalls = [...response.choices[0].message.tool_calls];

        while (toolCalls.length) {
          const toolCall = toolCalls.shift();
          const name = toolCall.function.name;
          // TODO handle arguments
          //const params = JSON.parse(toolCall.function.arguments)
          const callFunction = FUNCTION_CALLS[name];
          // TODO handle errors
          if (!callFunction) {
            res.json({ error: `Function ${name}(${toolCall.function.arguments}) not found` });
            return;
          }
          const data = await callFunction.apply(null );
          messages.push({ tool_call_id: toolCall.id, role: "tool", name, content: JSON.stringify(data) });

          response = await openai.chat.completions.create({ model: "gpt-4-turbo-preview", messages });
          messages.push(response.choices[0].message);
          // TODO if this new response also has a tool call, append it to toolCalls.
        }
      }
      break;
  case "noushermes2promistral":
  case "mistral:7b-instruct":
    messages = await callOllama(model, [
      {
        role: "system",
// TODO instruct the model to break down reasoning into separate function calls, one at a time. When one function call's arguments depend on the result from a previous call, there is no point
// in requesting the second call with dynamic argument placeholders. The model should be instructed to make the second call after the first call has been resolved.
        content: `You are a function calling AI model. You are provided with function signatures within <tools></tools> XML tags. You may call one or more functions to assist with the user query. \
Always make one function call at the time, and don't make assumptions about what values to plug into functions. Use the JSON schema specification for each tool call you will make: \
{'title': 'arguments', 'type': 'object', 'properties': {'options': {'title': 'Options', 'type': 'object'}, 'name': {'title': 'Name', 'type': 'string'}}, 'required': ['options', 'name']}
Here are the available tools:\n\
<tools>\n${formatHermes2Functions()}\n</tools>\n\
For each function call return a JSON object with function name and arguments within <tool_call></tool_call> XML tags as follows:\n \
<tool_call>\n \
{"name": "FUNCTION_NAME", "arguments": "ARGS_DICT" }\n \
</tool_call>\n`
      },
      { role: "user", content: prompt }
    ]);
    break;  
  }

  res.json({ error, messages });
});

app.listen(8000, () => console.log(`\nServer running on http://localhost:8000\n\nOLLAMA endpoint: ${CONFIG.OLLAMA.ENDPOINT}`));
