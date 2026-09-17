import { useState } from "react";
import { FIGURES, figureSrc, type FigureId } from "../lib/modelFigures";

// one figure out of ml/results. the png is 60 to 200 KB, so it loads only
// when it comes near the viewport, and it carries its own pixel size so the
// paragraph under it does not jump when it arrives.
//
// a tree that has never run the build has no public/figures, and a reader
// should get the sentence the figure was making rather than a broken image
export function ModelFigure({ id }: { id: FigureId }) {
  const figure = FIGURES[id];
  const [missing, setMissing] = useState(false);

  if (missing) {
    return (
      <figure className="model-figure is-missing">
        <figcaption>
          {figure.caption}
          <span className="model-absent">This figure is not in this build.</span>
        </figcaption>
      </figure>
    );
  }

  return (
    <figure className="model-figure">
      <img
        src={figureSrc(figure)}
        alt={figure.alt}
        width={figure.width}
        height={figure.height}
        loading="lazy"
        decoding="async"
        onError={() => setMissing(true)}
      />
      <figcaption>{figure.caption}</figcaption>
    </figure>
  );
}
