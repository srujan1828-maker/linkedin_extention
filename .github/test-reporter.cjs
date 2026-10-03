module.exports = async function* (events) {
  let passed = 0, failed = 0;
  const escape = value => String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  for await (const event of events) {
    if (event.type === 'test:pass') passed++;
    if (event.type === 'test:fail') {
      failed++;
      const data = event.data, error = data.details?.error;
      const detail = error?.cause?.stack || error?.stack || error?.message || 'Test failed';
      yield '::error::' + escape(data.name + '\n' + detail) + '\n';
    }
  }
  yield '::notice::' + passed + ' tests passed; ' + failed + ' failed.\n';
};
