# How Search Mode Works

This is a high level overview of how Perplexica answers a question in search mode.

If you want a component level overview, see [README.md](README.md).

If you want implementation details, see [CONTRIBUTING.md](../../CONTRIBUTING.md).

Computer mode uses the same session, persistence, and block-rendering infrastructure, but it routes through `POST /api/computer` and is documented separately in [`enhance.md`](../../enhance.md).

## What happens when you ask a question

When you send a message in the UI while search mode is selected, the app calls `POST /api/chat`.

At a high level, search mode does three things:

1. Classify the question and decide what to do next.
2. Run research and widgets in parallel.
3. Write the final answer and include citations.

```mermaid
flowchart TD
    A[User sends search message] --> B[POST /api/chat]
    B --> C[Classify Query]
    C --> D{Skip Search?}
    D -->|Yes| E[Generate Direct Answer]
    D -->|No| F[Start Research + Widgets]
    F --> G[Researcher Agent]
    F --> H[Widget Executor]
    G --> I[Web/Academic/File Search]
    H --> J[Weather/Stock/Calc Widgets]
    I --> K[Collect Sources]
    J --> L[Widget Results]
    K --> M[Generate Final Answer]
    L --> M
    E --> N[Stream Response]
    M --> N
    N --> O[UI renders blocks]
```

## Classification

Before searching or answering, we run a classification step.

This step decides things like:

- Whether we should do research for this question
- Whether we should show any widgets
- How to rewrite the question into a clearer standalone form

```mermaid
flowchart LR
    A[User Query] --> B[Classifier LLM]
    B --> C{Classification Flags}
    C --> D[skipSearch]
    C --> E[academicSearch]
    C --> F[discussionSearch]
    C --> G[personalSearch]
    C --> H[showWeatherWidget]
    C --> I[showStockWidget]
    C --> J[showCalculationWidget]
    B --> K[standaloneFollowUp]
    K --> L[Rewritten Query]
```

## Widgets

Widgets are small, structured helpers that can run alongside research.

Examples include weather, stocks, and simple calculations.

If a widget is relevant, we show it in the UI while the answer is still being generated.

Widgets are helpful context for the answer, but they are not part of what the model should cite.

## Research

If research is needed, we gather information in the background while widgets can run.

Depending on configuration, research may include web lookup and searching user uploaded files.

```mermaid
sequenceDiagram
    participant R as Researcher
    participant L as LLM
    participant A as ActionRegistry
    participant S as Search Backend
    
    loop Until 'done' or max iterations
        R->>L: streamText with available tools
        L-->>R: toolCallChunk (reasoning/plan)
        R->>R: emit reasoning substep
        L-->>R: toolCallChunk (search action)
        R->>A: executeAll(toolCalls)
        A->>S: web_search / academic_search
        S-->>A: search results
        A-->>R: action results
        R->>R: emit search_results substep
        R->>R: add to message history
    end
    R->>R: emit sources block
```

## Answer generation

Once we have enough context, the chat model generates the final response.

You can control the tradeoff between speed and quality using `optimizationMode`:

- `speed`
- `balanced`
- `quality`

```mermaid
flowchart LR
    A[Search Results] --> D[Writer Prompt]
    B[Widget Results] --> D
    C[User Query] --> D
    D --> E[LLM streamText]
    E --> F[TextBlock]
    F --> G[UI renders with citations]
    
    style E fill:#f9f,stroke:#333
```

## How citations work

We prompt the model to cite the references it used. The UI then renders those citations alongside the supporting links.

## Search API

If you are integrating Perplexica into another product, you can call `POST /api/search`.

It returns:

- `message`: the generated answer
- `sources`: supporting references used for the answer

You can also enable streaming by setting `stream: true`.

## Image and video search

Image and video search use separate endpoints (`POST /api/images` and `POST /api/videos`). We generate a focused query using the chat model, then fetch matching results from a search backend.
