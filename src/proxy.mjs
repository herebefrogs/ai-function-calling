import OpenAI from "openai";
import express from "express";
import { default as API_KEYS } from "../api-keys.json" with { type: "json" };


const client = new OpenAI({ apiKey: API_KEYS.OPENAI });


const app = express();
app.use(express.static("www"));
app.use(express.json()) // for parsing req.body when mine type is application/json

// Utils

const CONFIG = {
  ollama: {
    // endpoint: "http://localhost:11434/v1/chat/completions",
    endpoint: "https://82ak70uolcli9q-11434.proxy.runpod.net/v1/chat/completions",
  }
}

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

const OLLAMA = {
  chat: async (options) => {
    const response = await request(CONFIG.ollama.endpoint, "post", { model: "openhermes", stream: false, ...options });
console.log('ollama response', response, response.choices[0]);
    return response.choices[response.choices.length - 1].message.content;
  },
}




// 3rd party APIs function calls

  // TODO build a better function calling format and prompt chatML, and implement function calling validation
  // to ensure the function can be called and the parameters are correctly formatted

const FUNCTION_CALLS = {
  // Open-Notify: ISS location and people in space
  getISSLocation: async () => await request("http://api.open-notify.org/iss-now.json"),
  getPeopleInSpace: async () => await request("http://api.open-notify.org/astros.json")
};

// // TODO ollama only
// function parseFunctionCall(call) {
//   const [name, params] = call.split("(");
//   return { name, params: params.replace(")", "").split(",") };
// }

// Proxy Endpoints

app.post("/function/call", async (req, res) => {
  const { model, prompt } = req.body;

  let messages = [];
 
  switch(model) {
    case "gpt4":
      const tools = [
        {
          type: "function",
          function: {
            name: "getPeopleInSpace",
            description: "Get the number and name of people currently in space",
          }
        },
        {
          type: "function",
          function: {
            name: "getISSLocation",
            description: "Get the current location of the International Space Station",
          }    
        }
      ];
      messages.push({
        role: "system",
        content: "You are a assistant helping users to get an answer to their query. You do not guess, and call functions to get the information you need to answer the query."
      }, {
        role: "user",
        content: prompt
      })

      let response = await client.chat.completions.create({ model: "gpt-4-turbo-preview", messages, tools });
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
          const data = await callFunction.apply();
          messages.push({ tool_call_id: toolCall.id, role: "tool", name, content: JSON.stringify(data) });

          response = await client.chat.completions.create({ model: "gpt-4-turbo-preview", messages });
          messages.push(response.choices[0].message);
          // TODO if this new response also has a tool call, append it to toolCalls.
        }
      }

      res.json({ messages });
      break;
    case "openhermes":
      // TODO clean that up later
      messages.push({
        role: "system",
        content: "You are a helpfull assistant who does not guess when answering a user's queries. \
  Do not describe how a user can get the answer, just provide the answer. \
  If the information you need is in the history of your conversation with the user, leverage it in your answer. \
  If not, you can call some of the following Javascript functions to obtain that information by returning only: \
  Call: <name of the function to call>(<function parameters if any>) \
  \
  Functions:\
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
  function getISSLocation()"
      },
      { role: "user", content: prompt }
    );

      let answer = await OLLAMA.chat({ messages });
      
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
    
    console.log('function calling returned', data)
    // TODO wait, I don't do anything with data, I should add it to the messages
        messages.push({ role: "assistant", content: callRequest });
        messages.push({ role: "user", content: query });
    
    console.log('messages', messages);
    
        answer = await OLLAMA.chat({ messages });
      }
    
      res.json({ answer })
    }
  });

app.listen(8000, () => console.log("Server running on http://localhost:8000\nHave you updated the RunPod proxy URL in the CONFIG object?"));
