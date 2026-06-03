/* pdf-worker.js — extracts text from all PDF pages off the main thread.
   Receives:  { buffer: ArrayBuffer }
   Sends:     { type:'progress', done:N, total:N }
              { type:'done',     pdfText:string, total:N }
              { type:'error',    message:string }
*/
importScripts('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

self.onmessage = async function({ data: { buffer } }) {
  try {
    const pdf = await pdfjsLib.getDocument({
      data: new Uint8Array(buffer),
      disableFontFace: true,
      standardFontDataUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/standard_fonts/'
    }).promise;

    const total = pdf.numPages;
    let pdfText = '';

    for (let pn = 1; pn <= total; pn++) {
      const pg  = await pdf.getPage(pn);
      const tc  = await pg.getTextContent();
      const items = tc.items.filter(it => it.str && it.str.trim());
      const lineMap = {};
      items.forEach(it => {
        const y = Math.round(it.transform[5] / 4) * 4;
        if (!lineMap[y]) lineMap[y] = [];
        lineMap[y].push(it);
      });
      const pageText = Object.keys(lineMap).map(Number).sort((a, b) => b - a)
        .map(y => lineMap[y].sort((a, b) => b.transform[4] - a.transform[4]).map(it => it.str).join(' '))
        .join('\n');
      pdfText += `\n--- עמוד ${pn} ---\n${pageText}\n`;
      pg.cleanup();
      self.postMessage({ type: 'progress', done: pn, total });
    }

    pdf.destroy();
    self.postMessage({ type: 'done', pdfText, total });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message || String(err) });
  }
};
