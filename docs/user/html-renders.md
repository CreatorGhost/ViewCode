# Visual replies

Agents can answer with a page instead of only text: a chart, table, image collage, or mockup. Ask for one ("show this as a chart", "make a collage of these screenshots") and the agent builds a self-contained HTML page, which appears in the thread above its written reply. It works with every provider that has ViewCode's tools, on web, desktop, and mobile, including from a phone or a remote browser.

Pages use your current theme and follow light and dark mode as you switch. Scripts run inside the page, but it is sandboxed away from ViewCode and your session. Links you click in a page open in your browser. Use the expand button to open a page full size; from there you can save it.

Agents can place local images in a page by file path. ViewCode embeds them when the page is published (up to 10 MB per image and 25 MB per page), so the page keeps working after the original files move or are deleted. Reverting a turn removes the pages it published, and deleting the thread deletes all of them.

## Diagrams

Flowcharts, sequence, state and class diagrams, timelines and similar diagrams come as Mermaid instead, drawn right in the reply on web, desktop and the phone, with every provider and without ViewCode's tools. Diagrams follow your theme. Click one to open it full size, where you can zoom, pan, copy it as an image, or download it as PNG or SVG. On the phone, a diagram appears once its block has finished streaming; tap it to open it full screen and pinch to zoom. The phone downloads the diagram renderer the first time, so without internet it shows the diagram's code instead.

Architecture and tech-stack diagrams of real products (clouds, frameworks, databases) are drawn with the products' official logos instead: the agent builds the diagram and shows its picture in the reply, with the full page one click away. This needs Python 3 and internet access for the logos on the machine the agent runs on; without them, or when you ask for Mermaid, you get a Mermaid diagram.
