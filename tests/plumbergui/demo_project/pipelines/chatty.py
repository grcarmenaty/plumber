import logging

from canonada.pipeline import Node, Pipeline

log = logging.getLogger("canonada.demo")


def chat(lines: int) -> None:
    for i in range(int(lines)):
        log.info(f"chatty line {i + 1} of {lines}")
    log.warning("chatty: disk usage at 91%")
    try:
        {}["sensor_42"]
    except KeyError:
        log.error("chatty: lookup failed, carrying on", exc_info=True)
    print("chatty: plain print output", flush=True)


chatty = Pipeline(
    "chatty",
    [Node(func=chat, input=["params:chatty.lines"], output=["_"], name="chat")],
    description="Finishes. Logs INFO lines, a WARNING, an ERROR with a traceback, and a plain print line.",
)
