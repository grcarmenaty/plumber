from canonada.system import System

import pipelines.boom
import pipelines.chatty

nightly = System(
    "nightly",
    [pipelines.chatty.chatty, pipelines.boom.boom],
    description="Runs chatty, then boom, so the system ends as errored.",
)
