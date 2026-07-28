// LineItemExportProvider — REQ-013/AC7/FL6, EC2. See HANDOFF pitfall #5.
import { createContext, useContext, useState } from 'react';

const LineItemExportContext = createContext(null);

const PAGE_SIZE = 200;

// `api` provides:
//   fetchLineItems({ page, pageSize })      -> Promise<row[]>
//   queueExport({ filters, hasActiveFilters }) -> Promise<{ jobId }>
export const LineItemExportProvider = ({ children, api, filters, documentIds, totalRecords }) => {
  const [isLoading, setIsLoading] = useState(false);

  // TODO: implement CSV export.
  //
  // Rules:
  //   1. If the export count is greater than 100, queue it as a background job
  //      instead of downloading inline.
  //   2. The export count is the number of selected documentIds when the user has
  //      selected any; otherwise it is totalRecords.
  //   3. If the export count is zero, return an empty result without calling the API.
  //   4. Otherwise fetch every row by paging through api.fetchLineItems({ page, pageSize })
  //      until a page returns fewer rows than pageSize, then concatenate.
  //   5. The provider owns the loading state only when the user has not selected
  //      specific documents.
  //   6. `billType` is always sent as a filter key, but it must NOT count as a
  //      user-applied filter when deciding whether any filters are active.
  const exportLineItems = async () => {
    throw new Error('not implemented');
  };

  return (
    <LineItemExportContext.Provider value={{ exportLineItems, isLoading }}>
      {children}
    </LineItemExportContext.Provider>
  );
};

export const useLineItemExport = () => useContext(LineItemExportContext);
