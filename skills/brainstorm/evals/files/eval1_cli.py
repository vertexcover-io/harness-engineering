import sys
from eval1_service import getAccountInfo

if __name__ == "__main__":
    print(getAccountInfo(sys.argv[1]))
